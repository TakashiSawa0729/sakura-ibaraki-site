#!/usr/bin/env python3
"""
さくらこども園サイト ビルドスクリプト

  python3 build.py                 … content/ の記事だけでビルド
  NEWS_CSV_URL=... python3 build.py … Googleスプレッドシート（CSV公開URL）のお知らせも取り込む

出力: dist/  （そのまま静的ホスティングに置けます）
"""
import csv, copy, datetime as dt, hashlib, html as htmllib, io, json, os, re, shutil, sys, urllib.request
from urllib.parse import quote, unquote
from bs4 import BeautifulSoup

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, 'dist')
SITE_URL = os.environ.get('SITE_URL', 'https://sakura-ibaraki.jp').rstrip('/')
SITE_NAME = '社会福祉法人　秀桜会　さくらこども園'
CONFIG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))
JST = dt.timezone(dt.timedelta(hours=9))
NOW = dt.datetime.now(JST)
# 確認用サイトとして公開するときは PREVIEW=1（検索エンジンに載せない）
PREVIEW = os.environ.get('PREVIEW', '').lower() in ('1', 'true', 'yes')

def read(p):
    with open(os.path.join(ROOT, p), encoding='utf-8') as f:
        return f.read()

def write(path, text):
    # URL は %エンコードされているので、ファイル名は日本語のまま保存（サーバー側でデコードされる）
    p = os.path.join(DIST, unquote(path).lstrip('/'))
    if p.endswith('/'):
        p = os.path.join(p, 'index.html')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(text)

def url_path(p):
    """日本語を含むパスをURL用にエンコード"""
    return quote(unquote(p), safe='/-_.~')

def jdate(d):
    return '%d年%d月%d日' % (d.year, d.month, d.day)

def parse_date(s):
    s = (s or '').strip()
    for fmt in ('%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y/%m/%d %H:%M:%S', '%Y/%m/%d %H:%M', '%Y-%m-%d', '%Y/%m/%d', '%Y年%m月%d日'):
        try:
            return dt.datetime.strptime(s, fmt).replace(tzinfo=JST)
        except ValueError:
            pass
    return None

# ------------------------------------------------------------------ データ
CATS = json.load(open(os.path.join(ROOT, 'content/categories.json'), encoding='utf-8'))
CAT_BY_ID = {c['id']: c for c in CATS}
CAT_BY_NAME = {c['name']: c for c in CATS}

def load_posts():
    posts = json.load(open(os.path.join(ROOT, 'content/posts.json'), encoding='utf-8'))
    for p in posts:
        p['_date'] = parse_date(p['date'])
        p['_modified'] = parse_date(p.get('modified')) or p['_date']
    sheet = load_sheet_posts()
    known = {p['path'] for p in posts}
    for s in sheet:
        if s['path'] not in known:
            posts.append(s)
    posts.sort(key=lambda p: p['_date'], reverse=True)
    return posts

# ---- Googleスプレッドシートのお知らせ
def drive_direct(url):
    m = re.search(r'/d/([\w-]{20,})', url) or re.search(r'[?&]id=([\w-]{20,})', url)
    if 'drive.google.com' in url and m:
        return 'https://drive.google.com/uc?export=download&id=' + m.group(1)
    return url

def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'sakura-site-builder'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get('Content-Type', '')

def save_image(url, key):
    """シートの画像URLをダウンロードして dist/assets/news/ に保存し、パスを返す"""
    url = url.strip()
    if not url:
        return None
    try:
        m = re.search(r'/d/([\w-]{20,})', url) or re.search(r'[?&]id=([\w-]{20,})', url)
        gas = os.environ.get('GAS_URL') or CONFIG.get('gasUrl')
        if 'drive.google.com' in url and m and gas:
            # 共有設定をしていないドライブの画像も、管理用スクリプト経由で受け取る
            import base64
            raw, _ = fetch(gas + '?action=image&id=' + m.group(1))
            j = json.loads(raw)
            if not j.get('ok'):
                raise RuntimeError(j.get('error'))
            data, ctype = base64.b64decode(j['data']), j['type']
        else:
            data, ctype = fetch(drive_direct(url))
    except Exception as e:
        print('  画像を取得できません:', url, e)
        return None
    ext = {'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp'}.get(ctype.split(';')[0], '.jpg')
    name = 'assets/news/%s%s' % (key, ext)
    p = os.path.join(DIST, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f:
        f.write(data)
    return '/' + name

def text_to_html(text):
    out = []
    for para in re.split(r'\n\s*\n', (text or '').strip()):
        if not para.strip():
            continue
        h = htmllib.escape(para).replace('\n', '<br>')
        h = re.sub(r'(https?://[^\s<]+)', r'<a href="\1" target="_blank" rel="noopener">\1</a>', h)
        out.append('<p class="wp-block-paragraph">%s</p>' % h)
    return '\n'.join(out)

def load_sheet_posts():
    url = os.environ.get('NEWS_CSV_URL') or CONFIG.get('newsCsvUrl')
    gas = os.environ.get('GAS_URL') or CONFIG.get('gasUrl')
    if not url and gas:
        url = gas + '?action=news'
    if not url:
        return []
    print('スプレッドシートを読み込み中…')
    try:
        raw, _ = fetch(url)
    except Exception as e:
        print('  スプレッドシートを取得できませんでした（記事はこれまでの分だけで作ります）:', e)
        return []
    rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    posts = []
    for r in rows:
        if (r.get('公開') or '').strip().upper() not in ('TRUE', '公開', '○', '1', 'YES'):
            continue
        d = parse_date(r.get('日付'))
        title = (r.get('タイトル') or '').strip()
        if not d or not title:
            continue
        rid = (r.get('ID') or '').strip() or hashlib.md5((r.get('日付', '') + title).encode()).hexdigest()[:8]
        key = '%s-%s' % (d.strftime('%Y%m%d'), re.sub(r'[^\w-]', '', rid))
        cats = []
        for name in re.split(r'[,、/\s]+', r.get('カテゴリ') or ''):
            if name in CAT_BY_NAME:
                cats.append(CAT_BY_NAME[name]['id'])
        if not cats:
            cats = [CONFIG.get('defaultCategory', 4)]
        imgs = []
        for i in range(1, 11):
            u = r.get('画像%d' % i) or ''
            if u.strip():
                p = save_image(u, '%s-%d' % (key, i))
                if p:
                    imgs.append(p)
        body = text_to_html(r.get('本文'))
        if imgs:
            figs = ''.join('<figure class="wp-block-image size-large"><img src="%s" alt="" loading="lazy"></figure>' % p for p in imgs)
            if len(imgs) > 1:
                body += '<figure class="wp-block-gallery has-nested-images columns-2 is-cropped wp-block-gallery-is-layout-flex">%s</figure>' % figs
            else:
                body += figs
        text = re.sub(r'\s+', ' ', r.get('本文') or '')
        posts.append({
            'id': 'n' + key, 'path': '/news/%s/' % key, 'title': title,
            'date': d.isoformat(), '_date': d, '_modified': d, 'cats': cats,
            'thumb': imgs[0] if imgs else CONFIG.get('defaultThumb', ''),
            'excerpt': text[:120], 'css': '', 'body': body, 'source': 'sheet',
        })
    print('  お知らせ %d 件' % len(posts))
    return posts

# ------------------------------------------------------------------ 投稿カード
def primary_cat(p):
    for c in p['cats']:
        if CAT_BY_ID.get(c, {}).get('slug') != 'uncategorized':
            return CAT_BY_ID.get(c)
    return CAT_BY_ID.get(p['cats'][0]) if p['cats'] else None

def is_new(p):
    return (NOW - p['_date']).days < CONFIG.get('newDays', 7)

def fill_card(card, p, label=None):
    """VK Blocks の投稿カード(.vk_post)に記事データを流し込む"""
    href = url_path(p['path'])
    cls = [c for c in card.get('class', []) if not re.match(r'^(post-\d+|category-.*|has-post-thumbnail)$', c)]
    cls += ['post-%s' % p['id']] + ['category-%s' % CAT_BY_ID[c]['slug'] for c in p['cats'] if c in CAT_BY_ID]
    if p.get('thumb'):
        cls.append('has-post-thumbnail')
    card['class'] = cls
    card['id'] = 'post-%s' % p['id']
    for a in card.find_all('a'):
        a['href'] = href
    outer = card.select_one('.vk_post_imgOuter')
    if outer is not None:
        outer['style'] = 'background-image:url(%s)' % p.get('thumb', '')
    img = card.select_one('img.vk_post_imgOuter_img, img.wp-post-image')
    if img is not None:
        img['src'] = p.get('thumb', '')
        img['alt'] = ''
        img['loading'] = 'lazy'
        for a in ('width', 'height'):
            if img.has_attr(a):
                del img[a]
    lab = card.select_one('.vk_post_imgOuter_singleTermLabel')
    if lab is not None:
        if label:
            lab.string = label
        else:
            c = primary_cat(p)
            lab.string = c['name'] if c else ''
            if c and c.get('labelStyle'):
                lab['style'] = c['labelStyle']
    t = card.select_one('.vk_post_title')
    if t is not None:
        t.clear()
        t.append(p['title'])
        if is_new(p):
            s = BeautifulSoup('<span class="vk_post_title_new">New!!</span>', 'html.parser')
            t.append(s)
    d = card.select_one('.vk_post_date')
    if d is not None:
        icon = d.find('i')
        d.clear()
        if icon:
            d.append(icon)
        d.append(jdate(p['_date']))
    ex = card.select_one('.vk_post_excerpt, .vk_post_text')
    if ex is not None:
        ex.string = p.get('excerpt', '')
    return card

def select_posts(posts, cats, count):
    sel = [p for p in posts if not cats or set(cats) & set(p['cats'])]
    return sel[:count] if count else sel

def render_post_lists(root, posts):
    for el in root.select('[data-posts]'):
        q = json.loads(el['data-posts'])
        del el['data-posts']
        count = q.get('count') or 0
        if q.get('all'):
            count = 0
        items = select_posts(posts, q.get('cats') or [], count)
        if q['type'] == 'slider':
            wrapper = el.select_one('.swiper-wrapper')
            tpl = wrapper.select_one('.vk_slider_item')
            tpl.extract()
            for i, p in enumerate(items):
                it = copy.copy(tpl)
                it['class'] = [c for c in it.get('class', []) if not c.startswith('vk_slider_item-') or c in ('vk_slider_item-paddingVertical-none', 'vk_slider_item-background-area')]
                fill_card(it.select_one('.vk_post'), p)
                wrapper.append(it)
        else:
            tpl = el.select_one('.vk_post')
            tpl.extract()
            for p in items:
                el.append(fill_card(copy.copy(tpl), p))

# ------------------------------------------------------------------ ページの組み立て
HEADER = read('src/partials/header.html')
FOOTER = read('src/partials/footer.html')
FONTS = json.loads(read('src/partials/fonts.json'))
CSS_VER = hashlib.md5(read('static/assets/css/common.css').encode()).hexdigest()[:8]
JS_VER = hashlib.md5(read('static/assets/js/site.js').encode()).hexdigest()[:8]

def nav_current(header_html, path):
    s = BeautifulSoup(header_html, 'html.parser')
    for li in s.select('li'):
        li['class'] = [c for c in li.get('class', []) if c not in ('current-menu-item', 'current_page_item', 'current-menu-ancestor', 'current_page_parent')]
        a = li.find('a', recursive=False)
        if a and a.get('href') and url_path(a['href']) == url_path(path):
            li['class'] = li['class'] + ['current-menu-item']
    return str(s)

def page_html(title, inner, path, body_class='', description='', og_image='', extra_css='', extra_head=''):
    canonical = SITE_URL + url_path(path)
    desc = description or CONFIG.get('description', '')
    og = og_image or CONFIG.get('ogImage', '')
    if og.startswith('/'):
        og = SITE_URL + og
    fonts = '\n'.join('<link rel="stylesheet" href="%s">' % htmllib.escape(f if not f.startswith('//') else 'https:' + f) for f in FONTS)
    ga = CONFIG.get('googleAnalytics')
    ga_tag = ('<script async src="https://www.googletagmanager.com/gtag/js?id={0}"></script>'
              '<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments);}}gtag("js",new Date());gtag("config","{0}");</script>').format(ga) if ga else ''
    return f'''<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1">
{ga_tag}
<title>{htmllib.escape(title)}</title>
<meta name="description" content="{htmllib.escape(desc)}">
{'<meta name="robots" content="noindex,nofollow">' if PREVIEW else ''}
<link rel="canonical" href="{canonical}">
<meta property="og:site_name" content="{htmllib.escape(SITE_NAME)}">
<meta property="og:url" content="{canonical}">
<meta property="og:title" content="{htmllib.escape(title)}">
<meta property="og:description" content="{htmllib.escape(desc)}">
<meta property="og:type" content="{'website' if path == '/' else 'article'}">
<meta property="og:image" content="{htmllib.escape(og)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{CONFIG.get('favicon', '')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
{fonts}
<link rel="stylesheet" href="/assets/css/common.css?v={CSS_VER}">
<link rel="stylesheet" href="/assets/css/site.css?v={CSS_VER}">
{('<style>' + extra_css + '</style>') if extra_css.strip() else ''}
{extra_head}
</head>
<body class="{body_class}">
<a class="skip-link screen-reader-text" href="#main">コンテンツへスキップ</a>
<a class="skip-link screen-reader-text" href="#vk-mobile-nav">ナビゲーションに移動</a>
{nav_current(HEADER, path)}
{inner}
{FOOTER}
<script src="/assets/vendor/swiper-bundle.min.js"></script>
<script src="/assets/js/site.js?v={JS_VER}"></script>
</body>
</html>
'''

def split_meta(doc):
    m = re.match(r'<!--META\n(.*?)\n-->\n', doc, re.S)
    meta = json.loads(m.group(1))
    rest = doc[m.end():]
    css = ''
    m2 = re.match(r'<style>\n(.*?)\n</style>\n', rest, re.S)
    if m2:
        css = m2.group(1)
        rest = rest[m2.end():]
    return meta, css, rest

def build_pages(posts):
    for name in sorted(os.listdir(os.path.join(ROOT, 'src/pages'))):
        if not name.endswith('.html'):
            continue
        meta, css, inner = split_meta(read('src/pages/' + name))
        s = BeautifulSoup(inner, 'html.parser')
        render_post_lists(s, posts)
        extra_head = ''
        if s.select_one('.sk-booking') or s.select_one('.sk-contact'):
            extra_head = '<link rel="stylesheet" href="/assets/css/forms.css?v=%s"><script>window.SK_CONFIG=%s;</script><script src="/assets/js/forms.js?v=%s" defer></script>' % (
                CSS_VER, json.dumps({'gasUrl': os.environ.get('GAS_URL') or CONFIG.get('gasUrl', ''), 'recaptchaKey': CONFIG.get('recaptchaKey', '')}), JS_VER)
        write(meta['path'], page_html(meta['title'], str(s), meta['path'], meta.get('bodyClass', ''),
                                      meta.get('description', ''), meta.get('ogImage', ''), css, extra_head))
        print('page', meta['path'])

POST_TPL = read('src/templates/post.html')
POST_BODY_CLASS = read('src/templates/post.bodyclass')

def build_post(p, prev_p, next_p):
    s = BeautifulSoup(POST_TPL, 'html.parser')
    s.select_one('.page-header-title').string = p['title']
    pub = s.select_one('.published')
    if pub:
        pub.string = jdate(p['_date'])
    up = s.select_one('.updated')
    if up:
        up.string = jdate(p['_modified'])
    au = s.select_one('.entry-meta-item-author')
    if au:
        au.decompose()
    # パンくず
    bc = s.select_one('.breadcrumb-list')
    if bc:
        items = bc.select('li')
        c = primary_cat(p)
        if len(items) >= 3 and c:
            a = items[1].find('a')
            a['href'] = '/category/%s/' % c['slug']
            a.find('span').string = c['name']
            items[-1].find('span').string = p['title']
    art = s.select_one('article.entry')
    art['id'] = 'post-%s' % p['id']
    art['class'] = [x for x in art['class'] if not re.match(r'^(post-\d+|category-.*)$', x)] + ['post-%s' % p['id']]
    eb = s.select_one('.entry-body')
    eb.clear()
    eb.append(BeautifulSoup(p['body'], 'html.parser'))
    dd = s.select_one('.entry-meta-data-list--category dd')
    if dd:
        dd.clear()
        for i, cid in enumerate(p['cats']):
            c = CAT_BY_ID.get(cid)
            if not c:
                continue
            if i:
                dd.append('、')
            a = s.new_tag('a', href='/category/%s/' % c['slug'])
            a.string = c['name']
            dd.append(a)
    # 前後の記事
    np_ = s.select_one('.next-prev')
    if np_:
        cards = np_.select('.vk_post')
        prev_tpl = next((c for c in cards if 'next-prev-prev' in c['class']), None)
        next_tpl = next((c for c in cards if 'next-prev-next' in c['class']), None)
        for c in cards:
            c.extract()
        if prev_p and prev_tpl:
            np_.append(fill_card(prev_tpl, prev_p, '前の記事'))
        if next_p and next_tpl:
            np_.append(fill_card(next_tpl, next_p, '次の記事'))
    c = primary_cat(p)
    bclass = re.sub(r'category-\S+', '', POST_BODY_CLASS) + ' postid-%s' % p['id']
    if c:
        bclass += ' category-' + c['slug']
    write(p['path'], page_html('%s | %s' % (p['title'], SITE_NAME), str(s), p['path'], bclass,
                               p.get('excerpt', ''), p.get('thumb', ''), p.get('css', '')))

def build_archives(posts):
    """カテゴリー別の記事一覧 /category/<slug>/"""
    meta, css, inner = split_meta(read('src/pages/news-list.html'))
    base = BeautifulSoup(inner, 'html.parser')
    card_tpl = None
    for el in base.select('[data-posts]'):
        c = el.select_one('.vk_post')
        if c is not None:
            card_tpl = c
            break
    def list_page(path, title, items):
        s = BeautifulSoup(inner, 'html.parser')
        s.select_one('.page-header-title').string = title
        main = s.select_one('.entry-body') or s.select_one('.main-section')
        main.clear()
        lst = s.new_tag('div', attrs={'class': 'vk_posts vk_posts-postType-post vk_posts-layout-card vk_postList sk-archive'})
        for p in items:
            lst.append(fill_card(copy.copy(card_tpl), p))
        main.append(lst)
        bc = s.select_one('.breadcrumb-list li:last-child span')
        if bc:
            bc.string = title
        write(path, page_html('%s | %s' % (title, SITE_NAME), str(s), path, meta.get('bodyClass', ''), '', '', css))

    for c in CATS:
        items = [p for p in posts if c['id'] in p['cats']]
        if items:
            list_page('/category/%s/' % c['slug'], c['name'], items)
    # 月別（/2026/11/ など）
    months = {}
    for p in posts:
        months.setdefault((p['_date'].year, p['_date'].month), []).append(p)
    for (y, m), items in months.items():
        list_page('/%d/%02d/' % (y, m), '%d年%d月' % (y, m), items)
    # 過去の記事すべて
    list_page('/news-list2/', 'お知らせ一覧', posts)

def build_extras(posts):
    urls = []
    for name in os.listdir(os.path.join(ROOT, 'src/pages')):
        if name.endswith('.html'):
            meta, _, _ = split_meta(read('src/pages/' + name))
            urls.append((meta['path'], NOW))
    urls += [(p['path'], p['_modified']) for p in posts]
    urls += [('/category/%s/' % c['slug'], NOW) for c in CATS if c['slug'] != 'uncategorized']
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u, d in urls:
        sm.append('<url><loc>%s%s</loc><lastmod>%s</lastmod></url>' % (SITE_URL, url_path(u), d.date().isoformat()))
    sm.append('</urlset>')
    write('sitemap.xml', '\n'.join(sm))
    if PREVIEW:
        write('robots.txt', 'User-agent: *\nDisallow: /\n')
    else:
        write('robots.txt', 'User-agent: *\nAllow: /\nSitemap: %s/sitemap.xml\n' % SITE_URL)
    # 404
    meta, css, inner = split_meta(read('src/pages/privacy-policy.html'))
    s = BeautifulSoup(inner, 'html.parser')
    s.select_one('.page-header-title').string = 'ページが見つかりません'
    main = s.select_one('.entry-body') or s.select_one('.main-section')
    main.clear()
    main.append(BeautifulSoup('<p>お探しのページは移動または削除された可能性があります。</p><p><a href="/">トップページへ戻る</a></p>', 'html.parser'))
    write('404.html', page_html('ページが見つかりません | ' + SITE_NAME, str(s), '/404.html', meta.get('bodyClass', '')))
    # 記事データ（予約・お知らせの埋め込み等で利用）
    write('assets/data/news.json', json.dumps([{'title': p['title'], 'url': url_path(p['path']), 'date': p['_date'].date().isoformat(),
                                                 'cats': p['cats'], 'thumb': p.get('thumb', '')} for p in posts[:50]], ensure_ascii=False))

def main():
    # フォルダ自体は残して中身だけ消す（確認用サーバーを起動したままでも反映されるように）
    os.makedirs(DIST, exist_ok=True)
    for name in os.listdir(DIST):
        p = os.path.join(DIST, name)
        shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else os.remove(p)
    def link_or_copy(src, dst):
        try:
            os.link(src, dst)  # 画像が多いので、できればハードリンクで高速化
        except OSError:
            shutil.copy2(src, dst)
    shutil.copytree(os.path.join(ROOT, 'static'), DIST, copy_function=link_or_copy, dirs_exist_ok=True)
    posts = load_posts()
    build_pages(posts)
    for i, p in enumerate(posts):
        newer = posts[i - 1] if i > 0 else None
        older = posts[i + 1] if i + 1 < len(posts) else None
        build_post(p, older, newer)
    build_archives(posts)
    build_extras(posts)
    print('完了: 記事 %d 件 → %s' % (len(posts), DIST))

if __name__ == '__main__':
    main()
