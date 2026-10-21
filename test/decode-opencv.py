# Проверка сгенерированных QR НЕЗАВИСИМЫМ декодером (OpenCV).
# Это единственный тест, который имеет значение: он проверяет то же,
# что делает камера телефона.
#
# Запуск:
#   node test/sweep-all.js
#   python test/decode-opencv.py
import json, sys, numpy as np, cv2

CASES = json.load(open('test/sweepall.json', encoding='utf-8'))
det = cv2.QRCodeDetector()

def render(mods, size, scale=8, border=4):
    img = np.full(((size + border * 2) * scale,) * 2, 255, np.uint8)
    cells = {(int(a), int(b)) for a, b in mods}
    for (x, y) in cells:
        img[(y+border)*scale:(y+border+1)*scale, (x+border)*scale:(x+border+1)*scale] = 0
    return img

ok = 0
bad = []
for c in CASES:
    got = None
    for scale in (8, 6, 10, 12):
        d, _, _ = det.detectAndDecode(render(c['mods'], c['size'], scale))
        if d:
            got = d
            break
    good = (got == c['text'])
    if good:
        ok += 1
    else:
        bad.append((c['ecl'], c['version'], c['text'][:40], repr(got)[:40]))
    print("%s ecl=%s v%-2d size=%-2d %s" % (
        "OK  " if good else "FAIL", c['ecl'], c['version'], c['size'], c['text'][:46]))

print()
print("QR прочитано камерой: %d из %d" % (ok, len(CASES)))
for b in bad:
    print("  не прочитано:", b)

# ---- Выпущенные файлы assets/*.png -----------------------------------
# Адреса берутся из tools/gen-qr.mjs, чтобы тест не расходился со скриптом
# выпуска: поменяли адрес — тест требует перевыпустить файлы.
import re, os
gen = open('tools/gen-qr.mjs', encoding='utf-8').read()
targets = re.findall(r"name: '([^']+)',\s*\n\s*url: '([^']+)'", gen)

print()
bad_assets = []
for name, url in targets:
    f = 'assets/%s.png' % name
    if not os.path.exists(f):
        bad_assets.append((name, 'нет файла — запустите node tools/gen-qr.mjs'))
        print("FAIL %s: файла нет" % f)
        continue
    img = cv2.imdecode(np.fromfile(f, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    got, _, _ = det.detectAndDecode(img)
    good = (got == url)
    if not good:
        bad_assets.append((name, repr(got)[:60]))
    print("%s %s -> %s" % ("OK  " if good else "FAIL", f, got[:60]))

print()
print("Файлы assets: прочитано %d из %d" % (len(targets) - len(bad_assets), len(targets)))
for b in bad_assets:
    print("  проблема:", b)

sys.exit(0 if ok == len(CASES) and not bad_assets else 1)
