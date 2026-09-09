# User-local Windows installer; compatible with Windows PowerShell 5.1 and PowerShell 7.
# No administrator rights, global package install, or execution-policy changes.
& {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 2.0
    $stage = $null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    function Assert-NoReparsePath([string] $Path) {
        $current = [IO.Path]::GetFullPath($Path)
        while ($current) {
            if (Test-Path -LiteralPath $current) {
                $item = Get-Item -LiteralPath $current -Force
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Refusing a symbolic link or junction: $current"
                }
            }
            $parent = [IO.Path]::GetDirectoryName($current)
            if ($parent -eq $current) { break }
            $current = $parent
        }
    }

    function Assert-NoReparseTree([string] $Path) {
        Assert-NoReparsePath $Path
        if (Test-Path -LiteralPath $Path -PathType Container) {
            # Inspect one level before descending, so a junction is never traversed.
            foreach ($item in Get-ChildItem -LiteralPath $Path -Force) {
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Refusing a symbolic link or junction: $($item.FullName)"
                }
                if ($item.PSIsContainer) { Assert-NoReparseTree $item.FullName }
            }
        }
    }

    function Download-File([string] $Url, [string] $Destination, [long] $Limit = 134217728) {
        $uri = [Uri] $Url
        for ($redirect = 0; $redirect -le 5; $redirect++) {
            if ($uri.Scheme -ne 'https') { throw 'Only HTTPS downloads and redirects are permitted.' }
            $request = [Net.HttpWebRequest] [Net.WebRequest]::Create($uri)
            $request.AllowAutoRedirect = $false
            $request.UserAgent = 'AI-Preflight-Local-Installer'
            $request.Timeout = 20000
            $request.ReadWriteTimeout = 600000
            $response = $request.GetResponse()
            try {
                $status = [int] $response.StatusCode
                if (@(301, 302, 303, 307, 308) -contains $status) {
                    if ($redirect -eq 5 -or -not $response.Headers['Location']) { throw 'Too many or invalid redirects.' }
                    $uri = New-Object Uri($uri, $response.Headers['Location'])
                    continue
                }
                if ($status -ne 200) { throw "Download failed: HTTP $status" }
                if ($response.ContentLength -gt $Limit) { throw 'Download exceeds the size limit.' }
                $inputStream = $response.GetResponseStream()
                $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
                try {
                    $buffer = New-Object byte[] 65536
                    [long] $written = 0
                    while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $written += $read
                        if ($written -gt $Limit) { throw 'Download exceeds the size limit.' }
                        $outputStream.Write($buffer, 0, $read)
                    }
                } finally {
                    $outputStream.Dispose()
                    $inputStream.Dispose()
                }
                return
            } finally { $response.Dispose() }
        }
        throw 'Download did not complete.'
    }

    function Assert-Sha256([string] $Path, [string] $Asset, [string] $Manifest) {
        $expected = @()
        foreach ($line in [IO.File]::ReadAllLines($Manifest)) {
            if ($line -match '^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$' -and $Matches[2] -ceq $Asset) {
                $expected += $Matches[1]
            }
        }
        if ($expected.Count -ne 1) { throw "Checksum manifest must contain exactly one entry for $Asset" }
        $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
        if ($actual -ine $expected[0]) { throw "SHA256 mismatch: $Asset" }
    }

    function Expand-SafeZip([string] $Archive, [string] $Destination, [string] $Prefix, [switch] $Runtime) {
        if ((Get-Item -LiteralPath $Archive).Length -gt 134217728) { throw 'ZIP exceeds the compressed size limit.' }
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $allowed = @('app','components','config','docs','hooks','lib','public','scripts','server','services','src','tests','dist',
            '.dockerignore','.env.example','.gitignore','Dockerfile','compose.yaml','config.example.json','components.json',
            'index.html','LICENSE','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','README.md','README.en.md','CONTRIBUTING.md',
            'THIRD_PARTY_NOTICES.md','tsconfig.json','vite.config.ts','start.bat','start.command','install.sh','install.ps1')
        $forbidden = '^(?:\.git|\.env(?:\.(?!example$)[^/]+)?|config\.local\.json|node_modules|\.local|state|runtime|release|coverage|\.DS_Store)$|\.(?:pem|key|p12|pfx)$'
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $fileNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
        try {
            [long] $total = 0
            $count = 0
            $maxCount = 5000
            [long] $maxTotal = 268435456
            [long] $maxFile = 67108864
            if ($Runtime) { $maxCount = 20000; $maxTotal = 536870912; $maxFile = 134217728 }
            # Validate every member before writing any member, including unselected runtime files.
            foreach ($entry in $zip.Entries) {
                $name = $entry.FullName
                $directory = $name.EndsWith('/')
                $trimmed = $name.TrimEnd('/')
                $parts = $trimmed.Split('/')
                if (-not $name -or $name.Contains('\') -or $parts[0] -cne $Prefix -or (-not $directory -and $parts.Count -lt 2)) {
                    throw "Unsafe ZIP path: $name"
                }
                foreach ($part in $parts) {
                    if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part -match '[\x00-\x1f\x7f:"<>|?*]' -or
                        $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
                        throw "Unsafe Windows ZIP path: $name"
                    }
                }
                if (-not $Runtime -and $parts.Count -gt 1) {
                    if ($allowed -cnotcontains $parts[1]) { throw "Unexpected release path: $name" }
                    foreach ($part in $parts[1..($parts.Count - 1)]) {
                        if ($part -match $forbidden) { throw "Private or unexpected release path: $name" }
                    }
                }
                [long] $attributes = ([long] $entry.ExternalAttributes) -band 4294967295
                $unixType = ($attributes -shr 16) -band 61440
                if (($attributes -band 1024) -ne 0 -or ($unixType -ne 0 -and $unixType -ne 32768 -and $unixType -ne 16384) -or
                    ($unixType -eq 16384 -and -not $directory) -or ($unixType -eq 32768 -and $directory)) {
                    throw "ZIP links and special files are forbidden: $name"
                }
                if (-not $seen.Add($trimmed)) { throw "Duplicate ZIP path: $name" }
                if (-not $directory) { [void] $fileNames.Add($trimmed) }
                $count++
                $total += $entry.Length
                if ($entry.Length -lt 0 -or $entry.Length -gt $maxFile -or $total -gt $maxTotal -or $count -gt $maxCount -or
                    ($directory -and $entry.Length -ne 0)) { throw 'ZIP exceeds the entry, file, or total size limit.' }
            }
            foreach ($name in $seen) {
                $parent = $name
                while ($parent.Contains('/')) {
                    $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
                    if ($fileNames.Contains($parent)) { throw "ZIP file is also used as a directory: $parent" }
                }
            }
            $required = @('package.json','LICENSE','dist/index.html','server/index.mjs','scripts/launcher.mjs')
            if ($Runtime) { $required = @('node.exe','LICENSE') }
            foreach ($name in $required) {
                if (-not $fileNames.Contains("$Prefix/$name")) { throw "ZIP is missing required file: $name" }
            }
            [void] [IO.Directory]::CreateDirectory($Destination)
            $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
            foreach ($entry in $zip.Entries) {
                if ($entry.FullName.EndsWith('/')) { continue }
                $relative = $entry.FullName.Substring($Prefix.Length + 1)
                if ($Runtime -and @('node.exe','LICENSE') -cnotcontains $relative) { continue }
                $output = [IO.Path]::GetFullPath([IO.Path]::Combine($Destination, $relative.Replace('/', '\')))
                if (-not $output.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP escaped the staging directory.' }
                [void] [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))
                $inputStream = $entry.Open()
                $outputStream = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
                try {
                    $buffer = New-Object byte[] 65536
                    [long] $written = 0
                    while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $written += $read
                        if ($written -gt $entry.Length -or $written -gt $maxFile) { throw 'ZIP entry exceeds its declared size.' }
                        $outputStream.Write($buffer, 0, $read)
                    }
                    if ($written -ne $entry.Length) { throw 'ZIP entry is truncated.' }
                } finally {
                    $outputStream.Dispose()
                    $inputStream.Dispose()
                }
            }
        } finally { $zip.Dispose() }
    }

    function Test-Node([string] $Path) {
        try {
            # --version avoids the legacy PowerShell 5.1 native-argument quoting
            # rules, which can strip JavaScript string quotes passed via -e.
            $versionText = & $Path --version 2> $null
            if ($LASTEXITCODE -ne 0 -or @($versionText).Count -ne 1 -or $versionText -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { return $false }
            return ([Version] ($versionText.Substring(1))) -ge ([Version] '22.13.0')
        } catch { return $false }
    }

    try {
        if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows; use install.sh on macOS or Linux.' }
        $repo = $env:PREFLIGHT_REPOSITORY
        if (-not $repo) { $repo = '1571190347/ai-preflight-local' }
        if ($repo -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$') { throw 'Set PREFLIGHT_REPOSITORY to GitHubOwner/Repository.' }
        $root = $env:PREFLIGHT_INSTALL_DIR
        if (-not $root) {
            if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required, or set PREFLIGHT_INSTALL_DIR.' }
            $root = Join-Path $env:LOCALAPPDATA 'AI-Preflight-Local'
        }
        if ($root -notmatch '^[A-Za-z]:[\\/]' -or $root -match '(^|[\\/])\.\.([\\/]|$)' -or $root -match '[\x00-\x1f"<>|?*]') {
            throw 'PREFLIGHT_INSTALL_DIR must be an absolute local drive path without .. or invalid characters.'
        }
        $root = [IO.Path]::GetFullPath($root).TrimEnd('\')
        if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\') -or $root -eq $env:USERPROFILE) { throw 'Choose a dedicated install directory, not a drive root or home directory.' }
        Assert-NoReparsePath $root
        if (Test-Path -LiteralPath $root) {
            if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'The install path is not a directory.' }
            if (-not (Test-Path -LiteralPath (Join-Path $root '.preflight-install') -PathType Leaf) -and
                @(Get-ChildItem -LiteralPath $root -Force).Count -ne 0) { throw 'The install directory contains other files; choose an empty directory.' }
        }
        [void] [IO.Directory]::CreateDirectory($root)
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($identity.User)
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.User, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
        $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
        $systemRule = New-Object Security.AccessControl.FileSystemAccessRule($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($systemRule)
        Set-Acl -LiteralPath $root -AclObject $acl
        foreach ($name in @('app','app.previous','config','state','runtime','bin','.preflight-install','config\.env','config\config.local.json','bin\ai-preflight.cmd')) {
            Assert-NoReparsePath (Join-Path $root $name)
        }
        # Reserve the accepted directory before any staged download or app update.
        # A failed first installation can then be retried without deleting files.
        $markerPath = Join-Path $root '.preflight-install'
        if (-not (Test-Path -LiteralPath $markerPath)) {
            [IO.File]::WriteAllText($markerPath, '{"format":1,"pending":true}' + "`n", $utf8)
        }
        $stage = Join-Path $root ('.install.' + [Guid]::NewGuid().ToString('N'))
        [void] [IO.Directory]::CreateDirectory($stage)
        $nodePath = $null
        $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and (Test-Node $command.Source)) { $nodePath = $command.Source }
        $privateNode = Join-Path $root 'runtime\node.exe'
        Assert-NoReparsePath $privateNode
        if (-not $nodePath -and (Test-Path -LiteralPath $privateNode -PathType Leaf) -and (Test-Node $privateNode)) { $nodePath = $privateNode }
        if (-not $nodePath) {
            $architecture = $env:PROCESSOR_ARCHITEW6432
            if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
            switch ($architecture) {
                'AMD64' { $arch = 'x64' }
                'ARM64' { $arch = 'arm64' }
                default { throw 'Only Windows x64 and ARM64 are supported.' }
            }
            Write-Host 'Downloading a private Node.js 24 runtime and verifying the official SHA256...'
            $nodeManifest = Join-Path $stage 'NODE-SHASUMS256.txt'
            Download-File 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' $nodeManifest 4194304
            $nodeAssets = @()
            foreach ($line in [IO.File]::ReadAllLines($nodeManifest)) {
                if ($line -cmatch "^[a-fA-F0-9]{64}[ \t]+\*?(node-v24\.[0-9]+\.[0-9]+-win-$arch\.zip)$") { $nodeAssets += $Matches[1] }
            }
            if ($nodeAssets.Count -ne 1) { throw 'Cannot determine a unique official Node.js 24 archive.' }
            $nodeAsset = $nodeAssets[0]
            $nodeVersion = ($nodeAsset -split '-')[1]
            $nodeArchive = Join-Path $stage $nodeAsset
            Download-File "https://nodejs.org/dist/$nodeVersion/$nodeAsset" $nodeArchive
            Assert-Sha256 $nodeArchive $nodeAsset $nodeManifest
            $runtimeStage = Join-Path $stage 'runtime'
            Expand-SafeZip $nodeArchive $runtimeStage ($nodeAsset.Substring(0, $nodeAsset.Length - 4)) -Runtime
            if (-not (Test-Node (Join-Path $runtimeStage 'node.exe'))) { throw 'The downloaded Node.js cannot run. A supported Windows 10/11 or Windows Server system is required.' }
            # The runtime is published after the old app has stopped, avoiding Windows executable locks.
            $nodePath = Join-Path $runtimeStage 'node.exe'
        }
        $version = $env:PREFLIGHT_VERSION
        if (-not $version) {
            $metadata = Join-Path $stage 'release.json'
            Download-File "https://api.github.com/repos/$repo/releases/latest" $metadata 4194304
            $release = [IO.File]::ReadAllText($metadata) | ConvertFrom-Json
            if ($release.draft -or $release.prerelease) { throw 'GitHub did not return a stable release.' }
            $version = $release.tag_name
        }
        if ($version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'No stable vX.Y.Z release was found. You can set PREFLIGHT_VERSION explicitly.' }
        $asset = "ai-preflight-local-$version.zip"
        $base = "https://github.com/$repo/releases/download/$version"
        $manifest = Join-Path $stage 'SHA256SUMS'
        $archive = Join-Path $stage $asset
        Write-Host "Downloading AI Preflight Local $version and verifying SHA256..."
        Download-File "$base/SHA256SUMS" $manifest 4194304
        Download-File "$base/$asset" $archive
        Assert-Sha256 $archive $asset $manifest
        $appStage = Join-Path $stage 'app'
        Expand-SafeZip $archive $appStage 'ai-preflight-local'
        $package = [IO.File]::ReadAllText((Join-Path $appStage 'package.json')) | ConvertFrom-Json
        if ($package.name -cne 'ai-preflight-local' -or ('v' + $package.version) -cne $version) { throw 'Release version and package contents disagree.' }
        $oldLauncher = Join-Path $root 'app\scripts\launcher.mjs'
        if (Test-Path -LiteralPath $oldLauncher -PathType Leaf) {
            Assert-NoReparseTree (Join-Path $root 'app')
            & $nodePath $oldLauncher stop --install-dir $root
            if ($LASTEXITCODE -ne 0) { throw 'Could not safely stop the old instance. App files have not been replaced.' }
        }
        if (Test-Path -LiteralPath (Join-Path $stage 'runtime')) {
            [void] [IO.Directory]::CreateDirectory((Join-Path $root 'runtime'))
            foreach ($name in @('node.exe','LICENSE','SHASUMS256.txt')) { Assert-NoReparsePath (Join-Path $root "runtime\$name") }
            Copy-Item -LiteralPath (Join-Path $stage 'runtime\node.exe') -Destination $privateNode -Force
            Copy-Item -LiteralPath (Join-Path $stage 'runtime\LICENSE') -Destination (Join-Path $root 'runtime\LICENSE') -Force
            Copy-Item -LiteralPath (Join-Path $stage 'NODE-SHASUMS256.txt') -Destination (Join-Path $root 'runtime\SHASUMS256.txt') -Force
            $nodePath = $privateNode
        }
        $appPath = Join-Path $root 'app'
        $previous = Join-Path $root 'app.previous'
        if (Test-Path -LiteralPath $previous) {
            Assert-NoReparseTree $previous
            Remove-Item -LiteralPath $previous -Recurse -Force
        }
        if (Test-Path -LiteralPath $appPath) { Move-Item -LiteralPath $appPath -Destination $previous }
        try { Move-Item -LiteralPath $appStage -Destination $appPath }
        catch {
            if (-not (Test-Path -LiteralPath $appPath) -and (Test-Path -LiteralPath $previous)) { Move-Item -LiteralPath $previous -Destination $appPath }
            throw
        }
        foreach ($name in @('config','state','bin')) { [void] [IO.Directory]::CreateDirectory((Join-Path $root $name)) }
        # An ASCII wrapper reads the Unicode node path from JSON. This also works when
        # Windows user names contain characters outside the current console code page.
        $wrapperScript = @'
$ErrorActionPreference = 'Stop'
try {
    $root = [IO.Path]::GetFullPath($env:PREFLIGHT_INSTALL_DIR)
    $command = $env:PREFLIGHT_COMMAND
    if (-not $command) { $command = 'start' }
    if (@('start','stop','status','open') -cnotcontains $command) { throw 'Use start, stop, status, or open.' }
    $record = [IO.File]::ReadAllText((Join-Path $root '.preflight-install')) | ConvertFrom-Json
    & $record.node (Join-Path $root 'app\scripts\launcher.mjs') $command --install-dir $root
    exit $LASTEXITCODE
} catch { Write-Error $_; exit 1 }
'@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapperScript))
        $wrapper = '@echo off' + "`r`n" + 'setlocal DisableDelayedExpansion' + "`r`n" +
            'set "PREFLIGHT_INSTALL_DIR=%~dp0.."' + "`r`n" + 'set "PREFLIGHT_COMMAND=%~1"' + "`r`n" +
            '"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded +
            "`r`n" + 'exit /b %errorlevel%' + "`r`n"
        [IO.File]::WriteAllText((Join-Path $root 'bin\ai-preflight.cmd'), $wrapper, $utf8)
        $marker = @{ version = $version; node = $nodePath; format = 1 } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $root '.preflight-install'), $marker + "`n", $utf8)
        $envFile = Join-Path $root 'config\.env'
        $configFile = Join-Path $root 'config\config.local.json'
        if (-not (Test-Path -LiteralPath $envFile)) { [IO.File]::WriteAllText($envFile, "# Private local settings; preserved on upgrade.`n", $utf8) }
        if (-not (Test-Path -LiteralPath $configFile)) { [IO.File]::WriteAllText($configFile, "{}`n", $utf8) }
        Write-Host "Installed: $root"
        Write-Host "Start / stop / status / open: & `"$root\bin\ai-preflight.cmd`" start|stop|status|open"
        if ($env:PREFLIGHT_NO_START -ne '1') {
            & $nodePath (Join-Path $root 'app\scripts\launcher.mjs') start --install-dir $root
            if ($LASTEXITCODE -ne 0) { throw 'Installed, but startup failed. Run the status command and inspect the state directory.' }
        }
    } finally {
        if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
}
