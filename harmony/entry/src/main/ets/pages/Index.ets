import { webview } from '@kit.ArkWeb';
@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State failed: boolean = false;
  aboutToAppear(): void {
    try {
      webview.WebCookieManager.configCookieSync('https://codesip.ddyu.online', '');
    } catch (_) {}
  }
  aboutToDisappear(): void {
    try {
      webview.WebCookieManager.saveCookieSync();
    } catch (_) {}
  }
  build() {
    Stack() {
      Web({ src: 'https://codesip.ddyu.online', controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(false)
        .mixedMode(MixedMode.None)
        .zoomAccess(false)
        .cacheMode(CacheMode.Default)
        .onPageBegin(() => { this.failed = false; })
        .onPageEnd(() => {
          try {
            webview.WebCookieManager.saveCookieSync();
          } catch (_) {}
        })
        .onErrorReceive((event) => {
          if (event && event.request.isMainFrame()) { this.failed = true; }
        })
        .onOverrideUrlLoading((request: WebResourceRequest) => {
          const url = request.getRequestUrl();
          return !(url === 'https://codesip.ddyu.online' || url.startsWith('https://codesip.ddyu.online/'));
        })
        .onSslErrorEventReceive((event) => { if (event) { event.handler.handleCancel(); } })
        .width('100%')
        .height('100%')
      if (this.failed) {
        Column({ space: 20 }) {
          Text('CodeSip').fontSize(30).fontWeight(FontWeight.Medium).fontColor('#25414A')
          Text('暂时无法打开阅读空间').fontSize(18).fontColor('#202929')
          Text('请检查网络，然后重试。已保存的离线内容由阅读器自动恢复。')
            .fontSize(14).fontColor('#717F7D').textAlign(TextAlign.Center)
          Button('重新连接').backgroundColor('#365E64').onClick(() => { this.failed = false; this.controller.refresh(); })
        }.padding(32).width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor('#F3F2ED')
      }
    }.width('100%').height('100%')
  }
  onBackPress(): boolean {
    try {
      if (this.controller.accessBackward()) { this.controller.backward(); return true; }
    } catch (_) {
      return false;
    }
    return false;
  }
}
