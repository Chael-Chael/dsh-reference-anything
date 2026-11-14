export type KubaiIconData = { readonly name: string }
export type KubaiIconName =
  | 'folder' | 'file' | 'file-image' | 'file-text' | 'file-code' | 'database' | 'file-archive' | 'file-spreadsheet'
  | 'file-audio' | 'file-video' | 'presentation' | 'command' | 'paperclip' | 'export' | 'import' | 'undo'
  | 'message-circle' | 'scroll' | 'bot' | 'cloud' | 'sync' | 'puzzle' | 'target' | 'list-checks' | 'message-square'
  | 'shield' | 'cpu' | 'lock' | 'loader' | 'globe' | 'whale'
export declare const KUBAI_ICONS: Readonly<Record<KubaiIconName, KubaiIconData>>
export declare function createIcon(icon: KubaiIconData, options?: { size?: number; color?: string; variant?: 'color' | 'soft'; trigger?: 'hover' | 'parent' | 'none'; title?: string; className?: string }): SVGSVGElement
