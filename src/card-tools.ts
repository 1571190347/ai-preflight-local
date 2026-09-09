import { redact } from './browser-tools.js';

export type CardTheme = {
  id: string;
  name: string;
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  panel: string;
};
export type CardDecoration = { id: string; name: string; svg: string };

/** Original palettes and geometry. No fonts, images, services, or remote references. */
export const cardThemes: readonly CardTheme[] = [
  ['pine', '松林', '#102d28', '#f0faf0', '#aac6ba', '#b6ef88', '#173c34'],
  ['ocean', '远洋', '#092b44', '#f3faff', '#a2c5de', '#67d5e5', '#123a52'],
  ['ink', '墨色', '#15191f', '#f4f6fa', '#b6bdca', '#d8e2f3', '#262b34'],
  ['amber', '琥珀', '#362917', '#fff5da', '#d7c7a7', '#ffd073', '#4d3920'],
  ['clay', '陶土', '#432b27', '#fff3ea', '#dbc0b5', '#fba886', '#5a3931'],
  ['plum', '梅紫', '#302035', '#fcf1ff', '#cbb4d3', '#dfa8f0', '#442d4b'],
  ['indigo', '靛蓝', '#202541', '#f1f2ff', '#b6bfe0', '#9cabff', '#2d3457'],
  ['lagoon', '蓝湖', '#123b3d', '#edffff', '#aacfd0', '#7be4d1', '#1c4f51'],
  ['rose', '蔷薇', '#412438', '#fff0f8', '#d5b5c8', '#ffa2cd', '#562f49'],
  ['coffee', '咖啡', '#352b25', '#fff7ef', '#ccbcae', '#e7bb89', '#4b3b2f'],
  ['moss', '苔原', '#293223', '#f3f9e9', '#bcc9ad', '#c1dd91', '#3b482e'],
  ['midnight', '子夜', '#111d36', '#eff5ff', '#acbddb', '#80b5ff', '#1c2d4b'],
  ['paper', '素纸', '#f5f2e9', '#243432', '#566761', '#23675b', '#e9e5d8'],
  ['ice', '冰川', '#eaf4fa', '#183847', '#506c7b', '#276c93', '#d8e9f2'],
  ['petal', '花瓣', '#faedf0', '#4a2a3a', '#78576a', '#a14072', '#f0dce5'],
  ['apricot', '杏仁', '#faf0df', '#503723', '#7c6249', '#a66328', '#efdfc4'],
  ['mint', '薄荷', '#e9f6ed', '#244334', '#55745e', '#2f8158', '#d6eadc'],
  ['lavender', '薰衣草', '#f0ecfa', '#393052', '#6c607f', '#7451aa', '#e1daf0'],
  ['sand', '沙丘', '#ece6da', '#3d3a2c', '#6e6956', '#806635', '#ddd5c3'],
  ['citrus', '柚青', '#f2f6dc', '#364322', '#68734a', '#647d26', '#e2eac1'],
  ['coral', '珊瑚', '#fff0e9', '#51332c', '#805d52', '#b35842', '#f3dbd0'],
  ['mono', '白描', '#f4f5f6', '#252a32', '#626a78', '#38495e', '#e5e8ed'],
].map(([id, name, background, foreground, muted, accent, panel]) => ({
  id,
  name,
  background,
  foreground,
  muted,
  accent,
  panel,
}));

const decoration = (id: string, name: string, svg: string): CardDecoration => ({
  id,
  name,
  svg,
});
export const cardPatterns: readonly CardDecoration[] = [
  decoration(
    'dots',
    '点阵',
    '<pattern id="card-pattern" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.5" fill="currentColor"/></pattern>',
  ),
  decoration(
    'grid',
    '方格',
    '<pattern id="card-pattern" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="currentColor" stroke-width="1"/></pattern>',
  ),
  decoration(
    'diagonal',
    '斜线',
    '<pattern id="card-pattern" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M-6 6L6-6M0 24L24 0M18 30L30 18" fill="none" stroke="currentColor" stroke-width="1"/></pattern>',
  ),
  decoration(
    'wave',
    '涟漪',
    '<pattern id="card-pattern" width="48" height="24" patternUnits="userSpaceOnUse"><path d="M0 12Q12 0 24 12T48 12" fill="none" stroke="currentColor" stroke-width="1.2"/></pattern>',
  ),
  decoration(
    'cross',
    '十字',
    '<pattern id="card-pattern" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M12 8V16M8 12H16" fill="none" stroke="currentColor" stroke-width="1.2"/></pattern>',
  ),
  decoration(
    'diamond',
    '菱格',
    '<pattern id="card-pattern" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M18 2L34 18 18 34 2 18Z" fill="none" stroke="currentColor" stroke-width="1"/></pattern>',
  ),
  decoration(
    'dash',
    '短划',
    '<pattern id="card-pattern" width="36" height="24" patternUnits="userSpaceOnUse"><path d="M6 6H18M24 18H36" fill="none" stroke="currentColor" stroke-width="1.4"/></pattern>',
  ),
  decoration(
    'hex',
    '蜂巢',
    '<pattern id="card-pattern" width="48" height="42" patternUnits="userSpaceOnUse"><path d="M12 2H36L46 21 36 40H12L2 21Z" fill="none" stroke="currentColor" stroke-width="1"/></pattern>',
  ),
];

export const cardStamps: readonly CardDecoration[] = [
  decoration(
    'orbit',
    '轨道',
    '<circle r="24"/><ellipse rx="32" ry="12" transform="rotate(-35)"/><circle cx="22" cy="-15" r="4" fill="currentColor" stroke="none"/>',
  ),
  decoration(
    'prism',
    '棱镜',
    '<path d="M0-29L27 16H-27ZM0-29V16M-27 16L0 0 27 16"/>',
  ),
  decoration(
    'compass',
    '罗盘',
    '<circle r="27"/><path d="M0-20L7-7 20 0 7 7 0 20-7 7-20 0-7-7Z"/>',
  ),
  decoration(
    'layers',
    '层叠',
    '<path d="M0-25L29-8 0 9-29-8ZM-29 4L0 21 29 4M-29 16L0 33 29 16"/>',
  ),
  decoration(
    'bloom',
    '四叶',
    '<path d="M0 0C-35-35 35-35 0 0C35-35 35 35 0 0C35 35-35 35 0 0C-35 35-35-35 0 0Z"/><circle r="5"/>',
  ),
  decoration(
    'signal',
    '信号',
    '<circle cx="0" cy="20" r="3" fill="currentColor"/><path d="M-11 8Q0-3 11 8M-21-2Q0-23 21-2M-30-12Q0-42 30-12"/>',
  ),
  decoration(
    'window',
    '视窗',
    '<rect x="-25" y="-25" width="50" height="50" rx="9"/><path d="M0-25V25M-25 0H25M-18-18L18 18"/>',
  ),
  decoration(
    'spark',
    '星芒',
    '<path d="M0-31L7-8 30 0 7 8 0 31-7 8-30 0-7-8Z"/><circle r="16"/>',
  ),
];

export type IpCardOptions = {
  ip?: string;
  title?: string;
  detail?: string;
  theme?: string;
  pattern?: string;
  stamp?: string;
  hideIp?: boolean;
};

export function safeXML(value: string): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fit(value: string, maxUnits: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  let result = '';
  let width = 0;
  for (const char of normalized) {
    width += /[^\u0000-\u00ff]/u.test(char) ? 2 : 1;
    if (width > maxUnits) return `${result}…`;
    result += char;
  }
  return result;
}

/** A static 720 × 340 SVG: the IP is hidden by default, and nothing is fetched. */
export function makeIpCard({
  ip = '',
  title = '我的网络体检',
  detail = '本地生成 · 自己掌控数据',
  theme,
  pattern,
  stamp,
  hideIp = true,
}: IpCardOptions = {}): string {
  const palette = cardThemes.find((item) => item.id === theme) ?? cardThemes[0];
  const backdrop =
    cardPatterns.find((item) => item.id === pattern) ?? cardPatterns[0];
  const symbol = cardStamps.find((item) => item.id === stamp) ?? cardStamps[0];
  // Privacy covers free text too: pasting an IP in title/detail must not bypass hiding.
  const content = hideIp
    ? (redact({ title, detail }) as { title: string; detail: string })
    : { title, detail };
  const shownIp = hideIp ? 'IP 已隐藏' : ip.trim() || '尚未获取 IP';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="340" viewBox="0 0 720 340" role="img" aria-label="${safeXML(content.title)}">
<defs>${backdrop.svg}<clipPath id="card-clip"><rect width="720" height="340" rx="26"/></clipPath></defs>
<g clip-path="url(#card-clip)" color="${palette.accent}">
<rect width="720" height="340" fill="${palette.background}"/>
<rect width="720" height="340" fill="url(#card-pattern)" opacity=".10"/>
<rect x="24" y="24" width="672" height="292" rx="18" fill="${palette.panel}" fill-opacity=".90"/>
<g transform="translate(635 84)" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${symbol.svg}</g>
<g font-family="system-ui,-apple-system,BlinkMacSystemFont,sans-serif">
<text x="48" y="66" fill="${palette.accent}" font-size="11" font-weight="700" letter-spacing="2">LOCAL NETWORK / PERSONAL CARD</text>
<text x="48" y="111" fill="${palette.foreground}" font-size="27" font-weight="650">${safeXML(fit(content.title, 35))}</text>
<text x="48" y="191" fill="${palette.foreground}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="${shownIp.length > 28 ? 21 : 30}" font-weight="600">${safeXML(fit(shownIp, 42))}</text>
<text x="48" y="233" fill="${palette.muted}" font-size="15">${safeXML(fit(content.detail, 72))}</text>
<path d="M48 261H672" stroke="${palette.muted}" stroke-opacity=".24"/>
<text x="48" y="289" fill="${palette.muted}" font-size="11">静态图片 · 无追踪请求 · ${hideIp ? '隐私模式' : '已包含所选 IP'}</text>
<text x="672" y="289" text-anchor="end" fill="${palette.accent}" font-size="11">AI PREFLIGHT</text>
</g></g></svg>`;
}

function safeFilename(filename: string, extension: 'svg' | 'png'): string {
  const stem =
    filename
      .replace(/\.(?:svg|png)$/i, '')
      .replace(/[^a-z\d._\-\u3400-\u9fff]/gi, '-')
      .slice(0, 100) || 'ip-card';
  return `${stem}.${extension}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function downloadSvg(svg: string, filename = 'ip-card.svg'): void {
  downloadBlob(
    new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
    safeFilename(filename, 'svg'),
  );
}

/** Rasterizes locally with a bounded integer scale (1–4), then downloads PNG. */
export async function downloadPng(
  svg: string,
  filename = 'ip-card.png',
  scale = 2,
): Promise<void> {
  const ratio = Number.isFinite(scale)
    ? Math.min(4, Math.max(1, Math.round(scale)))
    : 2;
  const url = URL.createObjectURL(
    new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        img.onload = null;
        img.onerror = null;
        img.src = '';
        reject(new Error('卡片加载超时'));
      }, 5000);
      img.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('无法读取卡片 SVG'));
      };
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 720 * ratio;
    canvas.height = 340 * ratio;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器未提供 Canvas 2D');
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('PNG 导出失败'))),
        'image/png',
      ),
    );
    downloadBlob(blob, safeFilename(filename, 'png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** References only a static image file. Remote URLs, trackers, and active schemes are rejected. */
export function makeShareSnippets(
  filename = 'ip-card.png',
  title = '我的网络体检卡片',
): { html: string; markdown: string; bbcode: string } {
  if (
    !/^(?:\.\/)?[a-z\d_\u3400-\u9fff][a-z\d._ /\-\u3400-\u9fff]*\.(?:png|svg)$/i.test(
      filename,
    ) ||
    filename.split('/').some((part) => part === '..')
  ) {
    throw new Error(
      '分享片段只接受本地静态 PNG / SVG 文件路径，例如 images/ip-card.png',
    );
  }
  const localPath = filename.split('/').map(encodeURIComponent).join('/');
  const caption = String(redact(title)).replace(/[\r\n]+/g, ' ');
  return {
    html: `<img src="${safeXML(localPath)}" width="720" height="340" alt="${safeXML(caption)}" loading="lazy" />`,
    markdown: `![${caption.replace(/[\\\[\]]/g, '\\$&')}](${localPath})`,
    bbcode: `[img]${localPath}[/img]`,
  };
}
