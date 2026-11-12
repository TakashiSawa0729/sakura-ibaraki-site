# さくらこども園サイト（WordPress なし版）

元の sakura-ibaraki.jp（WordPress + Lightning + VK Blocks Pro）と同じ見た目を、
静的な HTML/CSS/JS で作り直したものです。WordPress・PHP・有料プラグインは使いません。

## しくみ

```
Googleスプレッドシート（お知らせ・予約・お問い合わせ）
        │  Apps Script（gas/Code.gs）が窓口
        ▼
GitHub Actions が 1時間ごと／ボタン1つで build.py を実行
        ▼
dist/（HTMLと画像）を GitHub Pages で公開
```

| フォルダ | 中身 |
|---|---|
| `src/pages/` | 各固定ページ（トップ、さくらこども園、さくらランド…）。文章を直すときはここ |
| `src/partials/` | 共通のヘッダー・フッター |
| `src/templates/` | お知らせ記事ページのひな形 |
| `content/posts.json` | WordPress から移したお知らせ・ブログ 83件 |
| `static/assets/` | 画像・CSS・JS |
| `gas/Code.gs` | スプレッドシートに入れる Apps Script |
| `build.py` | サイトを組み立てるスクリプト |
| `tools/import_wp.py` | WordPress からの移行に使った変換スクリプト（通常は使いません） |

## 移行のやり直し（通常は不要）

WordPress から書き出したデータ（`../source`）から作り直すときの順番です。

```
python3 tools/import_wp.py ../source   # ページ・記事・画像を取り込む
python3 tools/optimize_assets.py       # 画像を1600pxまでに縮小、動画をmp4に変換
python3 build.py
```

## 手元で確認する

```
pip install beautifulsoup4
python3 build.py
cd dist && python3 -m http.server 8000   # → http://localhost:8000
```

## 初期設定（最初の1回だけ）

### 1. 管理用スプレッドシート
1. Google ドライブで新しいスプレッドシートを作る（名前例：さくらこども園サイト管理）
2. 「拡張機能」→「Apps Script」を開き、`gas/Code.gs` の中身を貼り付けて保存
3. スプレッドシートを開き直し、メニュー「さくらサイト」→「初期設定（シートを作る）」
   （初回は Google の許可画面が出ます）
4. Apps Script の「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
   - 実行するユーザー：自分
   - アクセスできるユーザー：全員
5. 表示された URL（…/exec）を控える

### 2. GitHub
1. このフォルダを GitHub のリポジトリにする
   - `github-workflow-build.yml` を `.github/workflows/build.yml` に移動してから push する
2. Settings → Pages → Source を「GitHub Actions」に
3. Settings → Secrets and variables → Actions → Variables に追加
   - `GAS_URL` … 手順1-5の URL
   - `SITE_URL` … https://sakura-ibaraki.jp
   - `CUSTOM_DOMAIN` … 確認中は new.sakura-ibaraki.jp、本番は sakura-ibaraki.jp
   - `PREVIEW` … 確認中は 1（検索エンジンに載せない）。本番に切り替えたら消す
4. `config.json` の `gasUrl` にも同じ URL を入れる（予約・問い合わせフォームが使います）

### 3.「サイトに今すぐ反映する」ボタン（任意）
- GitHub で Fine-grained token（対象リポジトリの Contents: Read and write）を作る
- Apps Script の「プロジェクトの設定」→ スクリプト プロパティに `GITHUB_TOKEN` として保存
- 「設定」シートの「GitHubリポジトリ」に `ユーザー名/リポジトリ名` を入れる

### 4. ドメインの切り替え
DNS で sakura-ibaraki.jp を GitHub Pages に向けます（A レコード 185.199.108.153 ほか、www は CNAME）。
メール（@sakura-ibaraki.jp）の MX レコードは変更しないでください。

## 職員さんの使い方

### お知らせを出す
「お知らせ」シートに1行追加します。

| 列 | 入れるもの |
|---|---|
| 公開 | チェックを入れると公開。外すと非公開 |
| 日付 | 2026/11/20 のように |
| タイトル | 記事のタイトル |
| カテゴリ | さくらこども園／さくらランド／カラフル から選ぶ |
| 本文 | 文章。空行で段落が分かれます |
| 画像1〜6 | Google ドライブの画像の共有リンク（共有設定は変えなくてOK） |

1時間以内に自動で反映されます。急ぐときはメニュー「さくらサイト」→「サイトに今すぐ反映する」。

### 予約枠を作る
「予約枠」シートに1行＝1回分を追加します。
- 施設：さくらキッズ／こそだてランド
- 日付・開始時刻（10:00 のように）・イベント名・定員
- 締切：開始の何分前で締め切るか（120 なら2時間前）
- 受付中：チェックを入れている間だけネットで申し込めます
- 受付方式：先着（定員で締切）／抽選（定員なしで申込を集める）

### 予約の確認
「予約」シートに申し込みが1件ずつ入ります。抽選の結果やキャンセルは「状態」列を変えてください
（キャンセル・落選にすると、その枠の残り数が戻ります）。

### フォームの項目を変える
「フォーム項目」シートで、予約フォームとお問い合わせフォームの項目を追加・変更できます。

## ライセンスについて
`static/assets/css/common.css` には Lightning テーマ・VK Blocks・ExUnit の CSS を含みます。
いずれも GPL ライセンスのため再利用できます。JavaScript はすべて書き直しています（スライダーは MIT ライセンスの Swiper）。
