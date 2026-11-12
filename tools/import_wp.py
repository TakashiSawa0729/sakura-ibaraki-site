#!/usr/bin/env python3
"""
WordPress（Lightning + VK Blocks）から書き出したHTMLを、静的サイト用の部品に分解する一度きりの変換スクリプト。

入力 : ../source/  （html/ assets/ css-original/ data/site.json）
出力 : src/partials/  src/pages/  src/templates/  content/  static/assets/css/common.css

使い方: python3 tools/import_wp.py ../source
"""
import json, os, re, sys, shutil, html as htmllib
from urllib.parse import unquote, quote, urlparse
from bs4 import BeautifulSoup, Comment, NavigableString

SRC = sys.argv[1] if len(sys.argv) > 1 else '../source'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://sakura-ibaraki.jp'

data = json.load(open(os.path.join(SRC, 'data/site.json')))
URLMAP = data['urlMap']  # 元URL(サイズ違い含む) -> 実際に保存したファイルのパス (wp-content/uploads/...)

def out(path, text):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(text)

# ---------------------------------------------------------------- URL 書き換え
def enc_path(p):
    """ファイルパス(日本語可)を URL 用にエンコード"""
    return quote(p, safe='/-_.~!$&\'()*+,;=:@%')

def local_asset(url):
    """アップロード画像などの URL を /assets/... に変換。見つからなければ None"""
    u = url.split('?')[0].split('#')[0]
    if u.startswith('//'):
        u = 'https:' + u
    cands = [u, unquote(u)]
    for c in list(cands):
        cands.append(quote(c, safe=':/%'))
    for c in cands:
        if c in URLMAP:
            return '/assets/' + enc_path(URLMAP[c])
    # サイズ違い(-300x200)を外して再検索
    m = re.match(r'^(.*?)-\d+x\d+(\.\w+)$', u)
    if m:
        return local_asset(m.group(1) + m.group(2))
    path = urlparse(u).path
    if '/wp-content/' in path or '/wp-includes/' in path:
        # 保存したはずのファイルか確認
        rel = unquote(path).lstrip('/')
        if os.path.exists(os.path.join(SRC, 'assets', rel)):
            return '/assets/' + enc_path(rel)
    return None

def rewrite_url(url):
    if not url:
        return url
    u = url.strip()
    if u.startswith(('mailto:', 'tel:', '#', 'data:', 'javascript:')):
        return u
    full = 'https:' + u if u.startswith('//') else u
    if full.startswith(SITE) or full.startswith('http://sakura-ibaraki.jp'):
        p = urlparse(full)
        if '/wp-content/' in p.path or '/wp-includes/' in p.path:
            la = local_asset(full)
            if la:
                return la
            return p.path  # 見つからない資産はパスだけ残す
        path = p.path or '/'
        return path + (('?' + p.query) if p.query else '') + (('#' + p.fragment) if p.fragment else '')
    return u

def rewrite_css_urls(css, base=None):
    def rep(m):
        raw = m.group(1).strip('\'" ')
        if raw.startswith('data:'):
            return m.group(0)
        if base and not raw.startswith(('http', '//', '/')):
            from urllib.parse import urljoin
            raw = urljoin(base, raw)
        elif raw.startswith('/') and not raw.startswith('//'):
            raw = SITE + raw
        return 'url("%s")' % rewrite_url(raw)
    return re.sub(r'url\(([^)]+)\)', rep, css)

def clean_tree(node):
    """スクリプト除去・URL書き換え・srcset除去"""
    for t in node.find_all(['script', 'noscript']):
        t.decompose()
    for c in node.find_all(string=lambda s: isinstance(s, Comment)):
        c.extract()
    for t in node.find_all(True):
        for attr in ('href', 'src', 'poster', 'data-src', 'action'):
            if t.has_attr(attr):
                t[attr] = rewrite_url(t[attr])
        for attr in ('srcset', 'sizes', 'data-srcset'):
            if t.has_attr(attr):
                del t[attr]
        if t.has_attr('style'):
            t['style'] = rewrite_css_urls(t['style'])
        if t.name == 'style' and t.string:
            t.string = rewrite_css_urls(t.string)
        if t.name == 'img' and t.has_attr('src') and not t.has_attr('loading'):
            t['loading'] = 'lazy'
    return node

# ---------------------------------------------------------------- 共通CSS
def build_common_css():
    h = open(os.path.join(SRC, 'html/index.html'), encoding='utf-8').read()
    head = BeautifulSoup(h[:h.find('<body')], 'html.parser')
    parts = []
    page_specific_ids = {'lightning-design-style-inline-css', 'core-block-supports-inline-css',
                         'vk-blocks-custom-css', 'core-block-supports-duotone-inline-css'}
    extra_links = ['wp-includes/blocks/cover/style.min.css', 'wp-includes/blocks/gallery/style.min.css']
    extra_inline = {}
    # ほかのページにしかない共通インラインCSS(table/list/file)も拾う
    for name in os.listdir(os.path.join(SRC, 'html')):
        hh = open(os.path.join(SRC, 'html', name), encoding='utf-8').read()
        for m in re.finditer(r"<style id=['\"](wp-block-(?:table|list|file|gallery|cover|video|details|embed)[^'\"]*)['\"][^>]*>(.*?)</style>", hh, re.S):
            extra_inline.setdefault(m.group(1), m.group(2))
    for el in head.find_all(['link', 'style']):
        if el.name == 'link' and 'stylesheet' in (el.get('rel') or []):
            href = el['href']
            if 'fonts.googleapis' in href:
                continue
            path = unquote(urlparse(href if not href.startswith('//') else 'https:' + href).path).lstrip('/')
            f = os.path.join(SRC, 'css-original', path)
            if os.path.exists(f):
                parts.append('/* %s */\n' % path + rewrite_css_urls(open(f, encoding='utf-8').read(), SITE + '/' + path))
        elif el.name == 'style':
            sid = el.get('id', '')
            if sid in page_specific_ids or not sid:
                continue
            parts.append('/* inline:%s */\n' % sid + rewrite_css_urls(el.string or ''))
    for p in extra_links:
        f = os.path.join(SRC, 'css-original', p)
        if os.path.exists(f):
            parts.append('/* %s */\n' % p + rewrite_css_urls(open(f, encoding='utf-8').read(), SITE + '/' + p))
    for k, v in extra_inline.items():
        parts.append('/* inline:%s */\n' % k + rewrite_css_urls(v))
    fonts = [unquote(el['href']).replace('&#038;', '&') for el in head.find_all('link') if 'fonts.googleapis' in el.get('href', '')]
    out('static/assets/css/common.css', '\n'.join(parts))
    return fonts

def page_css(soup_full):
    """ページ固有の <style>（head と body末尾）を集める"""
    css = []
    specific = ('lightning-design-style-inline-css', 'core-block-supports-inline-css',
                'vk-blocks-custom-css', 'core-block-supports-duotone-inline-css')
    for el in soup_full.find_all('style'):
        sid = el.get('id', '')
        in_head = el.find_parent('head') is not None
        top_body = el.parent is soup_full.body
        # head 内の id なしスタイル（ヘッダー透過など）と、ページ固有の id 付きスタイル、body 直下のスタイル
        if sid in specific or (in_head and not sid) or top_body:
            t = el.string or ''
            if 'booking-package' in t:
                continue  # 旧予約プラグイン用のスタイルは不要
            css.append(rewrite_css_urls(t))
    return '\n'.join(css)

# ---------------------------------------------------------------- 投稿リストの部品化
CAT_BY_SLUG = {c['slug']: c for c in data['cats']}
LABEL_STYLE = {}

def post_cats_from_classes(cls):
    return [CAT_BY_SLUG[c[9:]]['id'] for c in cls if c.startswith('category-') and c[9:] in CAT_BY_SLUG]

def infer_cats(per_item):
    """各カードのカテゴリから、リストが絞り込んでいるカテゴリを推定（7割以上に共通）"""
    if not per_item:
        return []
    from collections import Counter
    cnt = Counter(c for s in per_item for c in set(s))
    best = [c for c, n in cnt.items() if n >= 0.7 * len(per_item)]
    if len(best) == 1 and len(cnt) > 1:
        return best
    if len(cnt) == 1:
        return list(cnt)
    return []

def mark_post_lists(main):
    """投稿カードが並んでいる場所に data-posts を付け、ひな形の1件だけ残す"""
    found = []
    # (a) 投稿カードを並べたスライダー
    for sl in main.select('.vk_slider'):
        items = sl.select('.swiper-wrapper > .vk_slider_item')
        if items and all(it.select_one('.vk_post') for it in items):
            per = [post_cats_from_classes(it.select_one('.vk_post').get('class', [])) for it in items]
            q = {'cats': infer_cats(per), 'count': len(items), 'type': 'slider'}
            sl['data-posts'] = json.dumps(q)
            for it in items[1:]:
                it.decompose()
            found.append(q)
    # (b) 通常の投稿リスト
    for lst in main.select('.vk_posts'):
        if 'next-prev' in lst.get('class', []) or lst.find_parent(class_='vk_slider_item'):
            continue
        posts = lst.select(':scope > .vk_post')
        if not posts:
            continue
        per = [post_cats_from_classes(p.get('class', [])) for p in posts]
        q = {'cats': infer_cats(per), 'count': len(posts), 'type': 'list'}
        lst['data-posts'] = json.dumps(q)
        for p in posts[1:]:
            p.decompose()
        found.append(q)
    # ラベル色を記録
    for lab in main.select('.vk_post_imgOuter_singleTermLabel'):
        if lab.get('style'):
            LABEL_STYLE[lab.get_text(strip=True)] = lab['style']
    return found

# ---------------------------------------------------------------- ページ
PAGES = [
    # (保存ファイル名, 元HTML, 出力パス)
    ('top', 'index', '/'),
    ('kindergarten', 'kindergarten', '/kindergarten/'),
    ('one-day', 'one-day', '/one-day/'),
    ('nyuen-flow', 'nyuen-flow', '/nyuen-flow/'),
    ('sakuraland', 'sakuraland', '/sakuraland/'),
    ('colorful', 'colorful', '/colorful/'),
    ('kosodate-shien', 'kosodate-shien', '/kosodate-shien/'),
    ('sakura-kids-yoyaku', 'sakura-kids-yoyaku', '/sakura-kids-yoyaku/'),
    ('kosodate-land-yoyaku', 'kosodate-land-yoyaku', '/kosodate-land-yoyaku/'),
    ('companyinfo', 'companyinfo', '/companyinfo/'),
    ('contact-us', 'contact-us', '/contact-us/'),
    ('recruitment', 'recruitment', '/recruitment/'),
    ('privacy-policy', 'privacy-policy', '/privacy-policy/'),
    ('news-list', 'news-list', '/news-list/'),
]

def body_classes(soup):
    keep = []
    for c in soup.body.get('class', []):
        if c.startswith(('wp-theme', 'wp-child-theme', 'device-', 'postid-', 'page-id-')):
            continue
        keep.append(c)
    return ' '.join(keep)

def head_meta(soup):
    def m(sel, attr='content'):
        el = soup.select_one(sel)
        return el.get(attr) if el else ''
    return {
        'title': soup.title.get_text() if soup.title else '',
        'description': m('meta[name=description]'),
        'ogImage': rewrite_url(m('meta[property="og:image"]')),
    }

def replace_special(main, key):
    """予約カレンダー・問い合わせフォームを差し替え用の印に置換"""
    if key in ('sakura-kids-yoyaku', 'kosodate-land-yoyaku'):
        bp = main.select_one('#booking-package, [id^=booking-package], .booking-package')
        target = bp
        while target is not None and target.parent is not None and target.parent.name != '[document]' \
                and 'entry-body' not in (target.parent.get('class') or []) and 'main-section' not in (target.parent.get('class') or []) \
                and len(target.parent.find_all(True, recursive=False)) == 1:
            target = target.parent
        new = BeautifulSoup('<div class="sk-booking" data-calendar="%s"></div>' % ('kids' if 'kids' in key else 'land'), 'html.parser')
        if target is not None:
            target.replace_with(new)
        for el in main.select('[id^=booking-package], .booking-package, #booking_package_reCAPTCHA'):
            el.decompose()
    if key == 'contact-us':
        f = main.select_one('.wpcf7')
        if f:
            f.replace_with(BeautifulSoup('<div class="sk-contact"></div>', 'html.parser'))

def import_pages():
    header = footer = None
    meta_all = {}
    for key, src, path in PAGES:
        h = open(os.path.join(SRC, 'html', src + '.html'), encoding='utf-8').read()
        soup = BeautifulSoup(h, 'html.parser')
        css = page_css(soup)
        meta = head_meta(soup)
        meta.update({'path': path, 'bodyClass': body_classes(soup)})
        if header is None:
            header = clean_tree(soup.select_one('header.site-header'))
            tail = []
            for sel in ['footer.block-site-footer', '.vk-mobile-nav-menu-btn', '.vk-mobile-nav', 'a.page_top_btn']:
                el = soup.select_one(sel)
                if el:
                    tail.append(str(clean_tree(el)))
            footer = '\n'.join(tail)
        # header と footer の間（page-header / site-body / breadcrumb）
        parts = []
        node = soup.select_one('header.site-header').next_sibling
        while node is not None and not (getattr(node, 'name', None) == 'footer'):
            nxt = node.next_sibling
            if getattr(node, 'name', None):
                parts.append(node)
            node = nxt
        wrap = BeautifulSoup('<div id="__wrap"></div>', 'html.parser')
        w = wrap.div
        for p in parts:
            w.append(p.extract())
        replace_special(w, key)
        lists = mark_post_lists(w)
        clean_tree(w)
        meta['postLists'] = lists
        inner = ''.join(str(c) for c in w.contents)
        doc = '<!--META\n%s\n-->\n' % json.dumps(meta, ensure_ascii=False, indent=1)
        if css.strip():
            doc += '<style>\n%s\n</style>\n' % css
        doc += inner
        out('src/pages/%s.html' % key, doc)
        meta_all[key] = meta
        print('page', key, 'lists', lists)
    out('src/partials/header.html', str(header))
    out('src/partials/footer.html', footer)
    return meta_all

# ---------------------------------------------------------------- 投稿（記事）
def import_posts():
    tpl_src = '【ブログ】ハロウインパーティー'
    h = open(os.path.join(SRC, 'html', tpl_src + '.html'), encoding='utf-8').read()
    soup = BeautifulSoup(h, 'html.parser')
    # 記事ページのひな形
    parts = []
    node = soup.select_one('header.site-header').next_sibling
    while node is not None and getattr(node, 'name', None) != 'footer':
        nxt = node.next_sibling
        if getattr(node, 'name', None):
            parts.append(node)
        node = nxt
    wrap = BeautifulSoup('<div id="__wrap"></div>', 'html.parser').div
    for p in parts:
        wrap.append(p.extract())
    clean_tree(wrap)
    out('src/templates/post.html', ''.join(str(c) for c in wrap.contents))
    out('src/templates/post.bodyclass', body_classes(soup))

    posts = []
    media_by_id = {m['id']: m for m in data['media']}
    for p in data['posts']:
        link = p['link']
        path = urlparse(link).path
        if '__trashed' in path:
            continue  # ゴミ箱に入れた記事は移行しない
        name = unquote(path).strip('/')
        fh = os.path.join(SRC, 'html', name + '.html')
        body_html = p['content']['rendered']
        page_style = ''
        if os.path.exists(fh):
            s2 = BeautifulSoup(open(fh, encoding='utf-8').read(), 'html.parser')
            eb = s2.select_one('.entry-body')
            if eb:
                body_html = eb.decode_contents()
            page_style = page_css(s2)
        b = BeautifulSoup('<div>%s</div>' % body_html, 'html.parser').div
        clean_tree(b)
        thumb = ''
        fm = p.get('featured_media')
        if fm and fm in media_by_id:
            thumb = local_asset(media_by_id[fm]['source_url']) or ''
        if not thumb:
            img = b.find('img')
            if img and img.get('src'):
                thumb = img['src']
        text = re.sub(r'\s+', ' ', b.get_text(' ', strip=True))
        posts.append({
            'id': p['id'],
            'path': path,
            'title': htmllib.unescape(p['title']['rendered']),
            'date': p['date'],
            'modified': p['modified'],
            'cats': [c for c in p['categories']],
            'thumb': thumb,
            'excerpt': text[:120],
            'css': page_style,
            'body': b.decode_contents(),
            'source': 'wordpress',
        })
    posts.sort(key=lambda x: x['date'], reverse=True)
    out('content/posts.json', json.dumps(posts, ensure_ascii=False, indent=1))
    cats = [{'id': c['id'], 'name': c['name'], 'slug': c['slug'],
             'labelStyle': LABEL_STYLE.get(c['name'], '')} for c in data['cats']]
    out('content/categories.json', json.dumps(cats, ensure_ascii=False, indent=1))
    print('posts', len(posts))

if __name__ == '__main__':
    fonts = build_common_css()
    out('src/partials/fonts.json', json.dumps(fonts, ensure_ascii=False))
    import_pages()
    import_posts()
    # 画像などを static/assets へコピー
    dst = os.path.join(ROOT, 'static', 'assets')
    for top in ('wp-content', 'wp-includes'):
        s = os.path.join(SRC, 'assets', top)
        if os.path.exists(s):
            shutil.copytree(s, os.path.join(dst, top), dirs_exist_ok=True)
    print('done')
