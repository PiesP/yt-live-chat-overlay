# YouTube Live Chat Overlay

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md)

YouTube のライブ配信、プレミア公開、リプレイの上に、ライブチャットを
ニコニコ動画風の流れるコメントとして表示します。ユーザースクリプト、展開して
読み込む Chrome 拡張機能、一時的な Firefox 拡張機能として利用できます。

## 機能

- 右から左、左から右、上固定、下固定のコメントモード
- テキスト、絵文字、Super Chat、ステッカー、メンバーシップ、投稿者バッジの描画
- 最近のメッセージやリプレイメッセージのバックログ表示
- 速度、フォント、不透明度、アウトライン、セーフゾーン、レーン、深度の設定
- 自動または手動で選べる 6 つのインターフェース言語
- ブラウザーが Translator API を提供する場合の任意のブラウザー内チャット翻訳
- 設定のインポート、エクスポート、タブ間同期
- 利用可能な場合に OffscreenCanvas Worker を併用するメインスレッド Canvas2D 描画

## インストール

### ユーザースクリプト

[Tampermonkey](https://www.tampermonkey.net/) または
[Violentmonkey](https://violentmonkey.github.io/) をインストールしてから、
[最新のユーザースクリプト](https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js)を
インストールします。

ユーザースクリプトマネージャーは、スクリプトに埋め込まれたメタデータ URL
から更新を確認します。

### Chrome、Edge、Brave 拡張機能

リリースアーカイブは、展開して読み込む開発者向けビルドです。ブラウザー
ストアからはインストールされず、自動更新もされません。

1. [最新リリース](https://github.com/PiesP/yt-live-chat-overlay/releases/latest)から
   `yt-live-chat-overlay-chrome.zip` をダウンロードします。
2. アーカイブを永続的に保存するディレクトリへ展開します。
3. `chrome://extensions` を開き、**デベロッパー モード**を有効にします。
4. **パッケージ化されていない拡張機能を読み込む**を選択し、展開した
   ディレクトリを指定します。

### Firefox 拡張機能

1. [最新リリース](https://github.com/PiesP/yt-live-chat-overlay/releases/latest)から
   `yt-live-chat-overlay-firefox.zip` をダウンロードします。
2. `about:debugging#/runtime/this-firefox` を開きます。
3. **一時的なアドオンを読み込む**を選択し、ZIP ファイルを指定します。

この開発者向けインストールは Firefox の再起動時に削除されます。永続的に
利用する場合はユーザースクリプトを使用してください。

## 使い方

チャットがある YouTube のライブ配信、プレミア公開、またはリプレイを開きます。
オーバーレイは自動的に起動します。プレーヤーに追加された歯車ボタンから、表示、
バックログ、翻訳、パフォーマンス、アクセシビリティの各設定を変更できます。

## ブラウザー対応

| 配布方法 | 対応範囲 |
| --- | --- |
| ユーザースクリプト | Tampermonkey または Violentmonkey が対応する現行のデスクトップブラウザー |
| Chromium 拡張機能 | Chrome/Chromium 116+ のデベロッパー モード |
| Firefox 拡張機能 | Firefox 128+ の技術上の最低バージョン、一時的な開発者向けインストール |

翻訳対応は実行時に検出され、上記のブラウザー最低バージョンとは独立しています。
翻訳には、ブラウザー内蔵の Translator API と、選択した言語ペアの対応が必要です。
原文言語の自動検出には、利用可能な場合は Language Detector API を使用し、
利用できない場合はブラウザー内の Unicode ヒューリスティックに切り替えます。
ブラウザーが必要な言語モデルまたは言語パックをダウンロードすることがあります。
Translator を利用できない場合も、オーバーレイは翻訳なしで動作を続けます。

Firefox 128 は拡張機能の技術上の最低互換バージョンであり、Firefox 128 が現在も
サポート対象の ESR であることを示すものではありません。通常の利用とリリース
検証には、現在サポートされている Firefox を使用してください。

## プライバシーとセキュリティ

チャットの解析と描画はブラウザー内で行われます。このプロジェクトは解析、
テレメトリー、翻訳、チャット処理のサーバーを運用しません。YouTube と Google
の通常のメディアリクエストは引き続き発生します。保存領域とネットワークの詳細は
[プライバシー](./PRIVACY.md)、脆弱性の報告方法は
[セキュリティポリシー](./.github/SECURITY.md)を参照してください。

## プロジェクト文書

このプロジェクトは AI ツールの支援を受けて開発されています。

開発環境と検証は[コントリビューションガイド](./CONTRIBUTING.md)、拡張機能の
構成、ビルド、展開した拡張機能の読み込み方法は
[拡張機能ガイド](./extension/README.md)を参照してください。

## サポート

- 使い方とトラブルシューティング: [サポート](./SUPPORT.md)
- バグと機能要望: [GitHub Issues](https://github.com/PiesP/yt-live-chat-overlay/issues)
- リリース履歴: [変更履歴](./CHANGELOG.md)
- 脆弱性: [セキュリティポリシー](./.github/SECURITY.md)

## ライセンス

MIT。[LICENSE](./LICENSE)を参照してください。
