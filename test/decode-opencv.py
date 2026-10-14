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
sys.exit(0 if ok == len(CASES) else 1)
