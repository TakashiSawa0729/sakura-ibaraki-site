#!/usr/bin/env python3
"""
画像と動画を軽くする（移行時に1回だけ実行）
  ・写真は長辺1600pxまでに縮小し、JPEGは画質82で保存し直す（ファイル名はそのまま）
  ・.mov は Chrome などで再生できないので .mp4（H.264）に変換し、ページ内の参照も書き換える
  ・大きな .mp4 は 720p に縮小
使い方: python3 tools/optimize_assets.py
"""
import json, os, subprocess, sys
from urllib.parse import quote
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UP = os.path.join(ROOT, 'static/assets/wp-content/uploads')
MAX = 1600
SAFE = '/-_.~!$&\'()*+,;=:@%'  # import_wp.py の enc_path と同じ
saved = 0

def human(n):
    return '%.0fMB' % (n / 1048576)

for dirpath, _, files in os.walk(UP):
    for f in files:
        p = os.path.join(dirpath, f)
        ext = f.lower().rsplit('.', 1)[-1]
        before = os.path.getsize(p)
        if ext in ('jpg', 'jpeg', 'png', 'webp'):
            try:
                im = Image.open(p)
                im = ImageOps.exif_transpose(im)
                big = max(im.size) > MAX
                if not big and (ext == 'png' or before < 300 * 1024):
                    continue
                if big:
                    im.thumbnail((MAX, MAX), Image.LANCZOS)
                if ext in ('jpg', 'jpeg'):
                    im.convert('RGB').save(p, 'JPEG', quality=82, optimize=True, progressive=True)
                elif ext == 'png':
                    im.save(p, 'PNG', optimize=True)
                else:
                    im.save(p, 'WEBP', quality=82)
                after = os.path.getsize(p)
                saved += before - after
            except Exception as e:
                print('skip', f, e)

videos = {}
for dirpath, _, files in os.walk(UP):
    for f in files:
        ext = f.lower().rsplit('.', 1)[-1]
        if ext not in ('mov', 'mp4', 'm4v'):
            continue
        p = os.path.join(dirpath, f)
        before = os.path.getsize(p)
        if ext == 'mp4' and before < 8 * 1048576:
            continue
        out = p.rsplit('.', 1)[0] + '.mp4'
        tmp = out + '.tmp.mp4'
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', p, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast',
               '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '96k', tmp]
        r = subprocess.run(cmd)
        if r.returncode != 0:
            print('動画の変換に失敗:', f)
            continue
        os.replace(tmp, out)
        if out != p:
            os.remove(p)
            rel_old = os.path.relpath(p, os.path.join(ROOT, 'static')).replace(os.sep, '/')
            rel_new = os.path.relpath(out, os.path.join(ROOT, 'static')).replace(os.sep, '/')
            videos['/' + quote(rel_old, safe=SAFE)] = '/' + quote(rel_new, safe=SAFE)
        saved += before - os.path.getsize(out)
        print('動画', f, human(before), '→', human(os.path.getsize(out)))

# .mov → .mp4 の参照を書き換え
if videos:
    targets = [os.path.join(ROOT, 'content/posts.json')] + [os.path.join(ROOT, 'src/pages', n) for n in os.listdir(os.path.join(ROOT, 'src/pages'))]
    for t in targets:
        s = open(t, encoding='utf-8').read()
        o = s
        for a, b in videos.items():
            s = s.replace(a, b)
        s = s.replace('video/quicktime', 'video/mp4')
        if s != o:
            open(t, 'w', encoding='utf-8').write(s)
            print('参照を更新:', os.path.basename(t))
    json.dump(videos, open(os.path.join(ROOT, 'tools/video-renames.json'), 'w'), ensure_ascii=False, indent=1)

print('削減:', human(saved))
