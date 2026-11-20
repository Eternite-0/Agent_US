export interface CodexDesktopBridge {
  isDesktop: true;
  platform: string;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
  pickDirectory: () => Promise<{ path: string; name: string } | null>;
}

declare global {
  interface Window {
    codexDesktop?: CodexDesktopBridge;
    showDirectoryPicker?: () => Promise<{ name: string }>;
  }
}

export {};
