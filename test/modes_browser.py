"""게임 방식(정교한 시체·비밀·샌드위치)을 브라우저 4개로 한 판씩 (로컬 서버 + dist/local.html)
  cd server && npx wrangler dev --var SPEED:0.5   (다른 창)
  node build.js --server=http://127.0.0.1:8787 --out=dist/local.html
  python3 -m http.server 8000 --directory dist   (다른 창)
  python3 test/modes_browser.py [화면저장폴더]
"""
import sys, os, time, math, random
from playwright.sync_api import sync_playwright

URL = os.environ.get('PAGE', 'http://127.0.0.1:8000/local.html')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dr-modes'
os.makedirs(OUT, exist_ok=True)
errors = []


def shot(page, name, full=False):
    page.screenshot(path=f'{OUT}/{name}.png', full_page=full)


def wait_screen(page, sid, timeout=30000):
    page.wait_for_function(f"!document.getElementById('{sid}').hidden", timeout=timeout)


def stroke(page, pts, color=1, size=1):
    """pts: 그림판 기준 0..1 좌표 목록"""
    page.locator('#palette button').nth(color).click()
    page.locator('.sizes button').nth(size).click()
    box = page.locator('#pad').bounding_box()
    X = lambda u: box['x'] + u * box['width']
    Y = lambda v: box['y'] + min(0.998, v) * box['height']
    page.mouse.move(X(pts[0][0]), Y(pts[0][1]))
    page.mouse.down()
    for u, v in pts[1:]:
        page.mouse.move(X(u), Y(v), steps=3)
    page.mouse.up()


def circle(cx, cy, r, n=36, ry=None):
    ry = ry or r
    return [(cx + r * math.cos(i / n * 2 * math.pi), cy + ry * math.sin(i / n * 2 * math.pi)) for i in range(n + 1)]


def draw_part(page, part, seed):
    rnd = random.Random(seed)
    if part == 0:  # 머리 + 목이 아래 끝까지
        stroke(page, circle(.5, .42, .2, ry=.27), color=1, size=1)
        stroke(page, circle(.43, .38, .03), color=12, size=2)
        stroke(page, circle(.57, .38, .03), color=12, size=2)
        stroke(page, [(.42, .55), (.5, .6), (.58, .55)], color=4, size=1)
        stroke(page, [(.44, .68), (.43, .85), (.42, 1.0)], color=1, size=1)
        stroke(page, [(.56, .68), (.57, .85), (.58, 1.0)], color=1, size=1)
    elif part == 1:  # 몸통
        stroke(page, [(.42, 0.0), (.3, .2), (.28, .8), (.4, 1.0)], color=1, size=1)
        stroke(page, [(.58, 0.0), (.7, .2), (.72, .8), (.6, 1.0)], color=1, size=1)
        stroke(page, [(.3, .3), (.1, .5 + rnd.uniform(-.1, .1))], color=1, size=2)
        stroke(page, [(.7, .3), (.9, .45 + rnd.uniform(-.1, .1))], color=1, size=2)
        page.locator('[data-tool="fill"]').click()
        page.locator('#palette button').nth(9).click()
        box = page.locator('#pad').bounding_box()
        page.mouse.click(box['x'] + box['width'] * .5, box['y'] + box['height'] * .5)
        page.locator('[data-tool="pen"]').click()
    else:  # 다리
        stroke(page, [(.4, 0.0), (.35, .5), (.25, .9), (.15, .92)], color=1, size=2)
        stroke(page, [(.6, 0.0), (.65, .5), (.75, .9), (.85, .92)], color=1, size=2)


def draw_any(page, seed):
    rnd = random.Random(seed)
    for k in range(3):
        pts = [(rnd.uniform(.1, .9), rnd.uniform(.1, .9))]
        for i in range(10):
            pts.append((min(.95, max(.05, pts[-1][0] + rnd.uniform(-.1, .1))), min(.95, max(.05, pts[-1][1] + rnd.uniform(-.1, .1)))))
        stroke(page, pts, color=rnd.randrange(1, 18), size=rnd.randrange(0, 4))


def wait_task(pages, step):
    for pg in pages:
        pg.wait_for_function(f"window.__DR.S.task && window.__DR.S.task.step === {step} && document.getElementById('btn-submit')", timeout=30000)


def reveal_all(host, tag, shots=True):
    for pg in pages: wait_screen(pg, 's-reveal')
    k = 0
    while True:
        st = host.evaluate('window.__DR.S.st.room.status')
        if st == 'ended': break
        rv = host.evaluate('JSON.stringify(window.__DR.S.st.game.reveal)')
        g = host.evaluate('window.__DR.S.st.game')
        if shots and g['reveal']['chain'] == 0 and g['reveal']['idx'] == g['steps'] - 1:
            time.sleep(3.2)  # 다시 그리기 끝날 때까지
            shot(pages[1], f'{tag}-reveal-full', full=True)
        host.locator('#rv-host button').last.click()
        host.wait_for_function(f"window.__DR.S.st.room.status === 'ended' || JSON.stringify(window.__DR.S.st.game.reveal) !== {rv!r}")
        time.sleep(0.15)
        k += 1
    for pg in pages: wait_screen(pg, 's-album')
    time.sleep(1)
    shot(pages[2], f'{tag}-album', full=True)
    with host.expect_download() as d:
        host.click('#btn-save-story')
    import shutil
    shutil.copy(d.value.path(), f'{OUT}/{tag}-story.png')
    print(tag, '발표', k, '번 넘김, 이미지', os.path.getsize(f'{OUT}/{tag}-story.png'), 'bytes')


def set_mode(host, mode):
    idx = ['normal', 'sandwich', 'secret', 'corpse'].index(mode)
    host.locator('#set-mode button').nth(idx).click()
    host.wait_for_function(f"window.__DR.S.st.room.settings.mode === '{mode}'")
    host.locator('#set-draw button').first.click()  # 60초 (서버는 절반 속도)
    host.wait_for_function("window.__DR.S.st.room.settings.drawSec === 60")


with sync_playwright() as p:
    browser = p.chromium.launch()
    sizes = [(390, 844), (360, 740), (1280, 860), (414, 896)]
    names = ['주원', '민지', '다현', '서준']
    pages = []
    for i, (w, h) in enumerate(sizes):
        ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w < 500 else 1)
        ctx.route('https://fonts.googleapis.com/**', lambda route: route.fulfill(status=200, content_type='text/css', body=''))
        pg = ctx.new_page()
        pg.on('pageerror', lambda e, i=i: errors.append(f'{names[i]}: {e}'))
        pg.on('console', lambda m, i=i: errors.append(f'{names[i]} console: {m.text}') if m.type == 'error' and 'favicon' not in m.text else None)
        pages.append(pg)
    host = pages[0]
    host.goto(URL)
    host.fill('#name', names[0])
    host.click('#btn-create')
    wait_screen(host, 's-room')
    code = host.locator('#room-code').inner_text()
    for i, pg in enumerate(pages[1:], 1):
        pg.goto(URL + '#' + code)
        wait_screen(pg, 's-home')
        pg.fill('#name-invite', names[i])
        pg.click('#btn-join-invite')
        wait_screen(pg, 's-room')
    host.wait_for_function("document.querySelectorAll('#room-members .member:not(.empty)').length === 4")

    # ── 정교한 시체
    set_mode(host, 'corpse')
    shot(host, 'c0-room-host', full=True)
    shot(pages[1], 'c0-room-guest')
    assert pages[1].locator('#set-mode button[disabled]').count() == 3, '손님은 방식 못 바꿈'
    assert host.locator('#row-len').is_hidden()
    host.click('#btn-start')
    for part in range(3):
        wait_task(pages, part)
        assert pages[0].evaluate('window.__DR.S.task.part') == part
        if part > 0:
            for pg in pages: assert pg.locator('#strip-cv').is_visible(), '앞 그림 띠'
        for i, pg in enumerate(pages):
            draw_part(pg, part, part * 10 + i)
            if i == 0: shot(pg, f'c{part + 1}-draw-mobile')
            if i == 2: shot(pg, f'c{part + 1}-draw-desktop')
            pg.click('#btn-submit')
    reveal_all(host, 'c9')

    # ── 비밀
    host.click('#btn-again')
    wait_screen(host, 's-room')
    set_mode(host, 'secret')
    host.click('#btn-start')
    wait_task(pages, 0)
    for i, pg in enumerate(pages):
        pg.fill('#work-text', ['우산 쓴 고양이', '달에서 라면', '출근하는 펭귄', '춤추는 김밥'][i])
    time.sleep(0.2)
    shot(pages[0], 's1-prompt-secret')
    color = pages[0].evaluate("getComputedStyle(document.getElementById('work-text')).color")
    mask = pages[0].locator('.secret-field .mask').inner_text()
    assert mask == '●' * 8, mask
    print('비밀 글자 색', color, '가림', mask)
    for pg in pages: pg.click('#btn-submit')
    wait_task(pages, 1)
    for i, pg in enumerate(pages):
        draw_any(pg, 50 + i)
        if i == 0:
            shot(pg, 's2-draw-just')
            time.sleep(2.2)
            shot(pg, 's2-draw-faded')
            # 화면 캔버스가 다시 하얘졌는지 (가운데 줄 픽셀이 모두 흰색)
            white = pg.evaluate("""(() => { const c = document.getElementById('pad'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250) n++; return n; })()""")
            ops = pg.evaluate('window.__DR.S.task && document.getElementById("pad") && 1')
            print('비밀 그림: 2초 뒤 흰색 아닌 픽셀', white)
            assert white == 0, white
        pg.click('#btn-submit')
    wait_task(pages, 2)
    shot(pages[1], 's3-guess')
    for i, pg in enumerate(pages):
        pg.fill('#work-text', f'{names[i]}의 짐작')
        pg.click('#btn-submit')
    reveal_all(host, 's9')

    # ── 샌드위치
    host.click('#btn-again')
    wait_screen(host, 's-room')
    set_mode(host, 'sandwich')
    host.click('#btn-start')
    host.wait_for_function("window.__DR.S.st.game && window.__DR.S.st.game.mode === 'sandwich'")
    steps = host.evaluate('window.__DR.S.st.game.steps')
    kinds = host.evaluate('window.__DR.S.st.game.kinds')
    print('샌드위치 칸', steps, kinds)
    assert kinds == ['prompt', 'draw', 'draw', 'guess'], kinds
    wait_task(pages, 0)
    for i, pg in enumerate(pages):
        pg.fill('#work-text', ['해적선 위 피크닉', '공룡이 지하철 탐', '모기와의 전쟁', '눈사람 여름휴가'][i])
        pg.click('#btn-submit')
    wait_task(pages, 1)
    for i, pg in enumerate(pages):
        draw_any(pg, 70 + i)
        pg.click('#btn-submit')
    wait_task(pages, 2)
    time.sleep(3)
    for pg in pages: assert pg.locator('#ref-cv').is_visible(), '따라 그릴 그림'
    shot(pages[0], 'w2-follow-mobile', full=True)
    shot(pages[2], 'w2-follow-desktop')
    for i, pg in enumerate(pages):
        draw_any(pg, 80 + i)
        pg.click('#btn-submit')
    wait_task(pages, 3)
    for i, pg in enumerate(pages):
        pg.fill('#work-text', f'{names[i]}이 본 것')
        pg.click('#btn-submit')
    reveal_all(host, 'w9')
    browser.close()

bad = [e for e in errors if 'ERR_TUNNEL' not in e and 'fonts' not in e]
print('오류:', bad if bad else '없음')
print('게임 방식 브라우저 시험 끝')
sys.exit(1 if bad else 0)
