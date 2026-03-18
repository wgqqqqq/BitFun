declare namespace WebdriverIO {
  interface TauriOptions {
    application: string;
  }

  interface Capabilities {
    'tauri:options'?: TauriOptions;
  }
}
