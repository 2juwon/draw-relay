"""브라우저 여러 개로 한 판 끝까지 (로컬 서버 + dist/local.html)
  cd server && npx wrangler dev --var FAST_TEST:1   (다른 창)
  node build.js --server=http://127.0.0.1:8787 --out=dist/local.html
  python3 -m http.server 8000 --directory dist   (다른 창)
  python3 test/browser.py [화면저장폴더]
"""
import sys, os, time, random, json
from playwright.sync_api import sync_playwright

URL = os.environ.get('PAGE', 'http://127.0.0.1:8000/local.html')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dr-shots'
os.makedirs(OUT, exist_ok=True)
errors = []

def shot(page, name):
    page.screenshot(path=f'{OUT}/{name}.png', full_page=False)

def wait_screen(page, sid, timeout=20000):
    page.wait_for_function(f"!document.getElementById('{sid}').hidden", timeout=timeout)

def scribble(page, seed):
    rnd = random.Random(seed)
    cv = page.locator('#pad')
    box = cv.bounding_box()
    # 색·굵기 고르고 선 몇 개
    for k in range(3):
        page.locator('#palette button').nth(rnd.randrange(1, 18)).click()
        page.locator('.sizes button').nth(rnd.randrange(0, 5)).click()
        x, y = box['x'] + rnd.uniform(20, box['width'] - 20), box['y'] + rnd.uniform(20, box['height'] - 20)
        page.mouse.move(x, y); page.mouse.down()
        for i in range(14):
            x = min(box['x'] + box['width'] - 5, max(box['x'] + 5, x + rnd.uniform(-30, 30)))
            y = min(box['y'] + box['height'] - 5, max(box['y'] + 5, y + rnd.uniform(-25, 25)))
            page.mouse.move(x, y, steps=2)
        page.mouse.up()
    # 동그라미 하나 그리고 채우기
    cx, cy, r = box['x'] + box['width'] * .5, box['y'] + box['height'] * .5, box['width'] * .18
    import math
    page.locator('#palette button').nth(1).click()
    page.locator('.sizes button').nth(1).click()
    page.locator('[data-tool="pen"]').click()
    page.mouse.move(cx + r, cy); page.mouse.down()
    for i in range(1, 41):
        a = i / 40 * 2 * math.pi
        page.mouse.move(cx + r * math.cos(a), cy + r * math.sin(a))
    page.mouse.up()
    page.locator('[data-tool="fill"]').click()
    page.locator('#palette button').nth(7).click()
    page.mouse.click(cx, cy)
    page.locator('[data-tool="pen"]').click()

with sync_playwright() as p:
    browser = p.chromium.launch()
    sizes = [(390, 844), (360, 740), (1280, 860), (414, 896)]
    names = ['주원', '민지', '다현', '서준']
    pages = []
    for i, (w, h) in enumerate(sizes):
        ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w < 500 else 1, has_touch=False)
        if os.path.exists('dist/fonts/fonts.css'):  # 시험 환경에서 구글 글꼴 대신 내려받아 둔 글꼴
            css = open('dist/fonts/fonts.css').read()
            def serve_css(route, css=css): route.fulfill(status=200, content_type='text/css', body=css)
            ctx.route('https://fonts.googleapis.com/**', lambda route: serve_css(route))
        pg = ctx.new_page()
        pg.on('pageerror', lambda e, i=i: errors.append(f'{names[i]}: {e}'))
        pg.on('console', lambda m, i=i: errors.append(f'{names[i]} console: {m.text}') if m.type == 'error' and 'favicon' not in m.text and 'fonts.g' not in m.text else None)
        pages.append(pg)
    host = pages[0]
    host.goto(URL)
    shot(host, '01-home')
    host.fill('#name', names[0])
    host.click('#btn-create')
    wait_screen(host, 's-room')
    code = host.locator('#room-code').inner_text()
    print('방', code)
    for i, pg in enumerate(pages[1:], 1):
        pg.goto(URL + '#' + code)
        wait_screen(pg, 's-home')
        assert pg.locator('#home-invite').is_visible()
        if i == 1: shot(pg, '02-invite')
        pg.fill('#name-invite', names[i])
        pg.click('#btn-join-invite')
        wait_screen(pg, 's-room')
    host.wait_for_function("document.querySelectorAll('#room-members .member:not(.empty)').length === 4")
    # 설정: 그리기 60초 (시험 서버는 시간을 줄여 돌림)
    host.locator('#set-draw button').first.click()
    host.wait_for_function("window.__DR.S.st.room.settings.drawSec === 60")
    shot(host, '03-room-host')
    shot(pages[1], '04-room-guest')
    assert not pages[1].locator('#btn-start').is_visible()
    host.click('#btn-start')
    for pg in pages: wait_screen(pg, 's-play')

    # 1단계: 제시어 (한 명은 주사위)
    prompts = ['우산 쓴 고양이', '회의 중에 조는 부장님', None, '달에서 라면 먹기']
    for i, pg in enumerate(pages):
        pg.wait_for_selector('#work-text')
        if prompts[i] is None:
            pg.click('.dice')
        else:
            pg.fill('#work-text', prompts[i])
    shot(pages[0], '05-prompt')
    for i, pg in enumerate(pages):
        if i == 3: continue  # 서준은 Enter로
        pg.click('#btn-submit')
    pages[1].wait_for_selector('#wait-over')
    pages[1].wait_for_function("document.querySelectorAll('#who-done .av.ok').length === 3")
    shot(pages[1], '06-waiting')
    pages[3].press('#work-text', 'Enter')

    # 그리기 / 맞히기 반복
    for step in range(1, 4):
        for pg in pages:
            pg.wait_for_function(f"window.__DR.S.task && window.__DR.S.task.step === {step} && document.getElementById('btn-submit')", timeout=20000)
        kind = pages[0].evaluate('window.__DR.S.task.kind')
        print('단계', step, kind)
        for i, pg in enumerate(pages):
            if kind == 'draw':
                scribble(pg, step * 10 + i)
                if step == 1 and i == 0: shot(pg, '07-draw-mobile')
                if step == 1 and i == 2: shot(pg, '08-draw-desktop')
                if i == 1 and step == 1:
                    # 되돌리기·다시 하기 확인
                    n = pg.evaluate('window.__DR && document.querySelector("#pad") && 0')
                    pg.click('[data-tool="undo"]'); pg.click('[data-tool="redo"]')
            else:
                pg.wait_for_selector('#guess-cv')
                time.sleep(0.3)
                pg.fill('#work-text', f'{names[i]}의 생각 {step}')
                if step == 2 and i == 0:
                    time.sleep(1.2)
                    shot(pg, '09-guess')
            if not (kind == 'draw' and i == 3 and step == 3):  # 마지막 그리기 한 명은 시간 초과로
                pg.click('#btn-submit')
            if step == 1 and i == 2:
                # 고치기 한 번 (마지막 사람이 내기 전에)
                pg.wait_for_selector('#btn-fix')
                pg.click('#btn-fix')
                pg.wait_for_selector('#btn-submit')
                scribble(pg, 99)
                pg.click('#btn-submit')
                pg.wait_for_selector('#btn-fix')

    # 발표
    for pg in pages: wait_screen(pg, 's-reveal', timeout=30000)
    time.sleep(0.6)
    shot(host, '10-reveal-1')
    shot(pages[1], '11-reveal-guest')
    total = 0
    for k in range(4 * 4):
        info = host.evaluate('window.__DR.S.st.game.reveal')
        if info is None: break
        if k == 2:
            pages[1].locator('#rv-react button').nth(1).click()
            pages[2].locator('#rv-react button').nth(1).click()
            pages[3].locator('#rv-react button').nth(0).click()
            time.sleep(0.4)
            shot(pages[1], '12-reveal-react')
        if k == 3:
            time.sleep(2.5)
            shot(host, '13-reveal-story')
        host.locator('#rv-host button').last.click()
        total += 1
        host.wait_for_function(f"(window.__DR.S.st.room.status === 'ended') || JSON.stringify(window.__DR.S.st.game.reveal) !== '{json.dumps(info, separators=(',', ':'))}'")
        time.sleep(0.15)
    for pg in pages: wait_screen(pg, 's-album')
    time.sleep(1)
    shot(host, '14-album')
    shot(pages[2], '15-album-desktop')
    # 이미지 저장
    with host.expect_download() as d:
        host.click('#btn-save-story')
    path = d.value.path()
    print('저장 이미지', os.path.getsize(path), 'bytes')
    import shutil; shutil.copy(path, f'{OUT}/16-story.png')
    # 같은 이야기에 모든 칸이 있는지
    cnt = host.evaluate("Object.keys(window.__DR.S.entries).length")
    assert cnt == 16, cnt
    # 새로고침해도 앨범으로 돌아옴
    pages[1].reload()
    wait_screen(pages[1], 's-album')
    pages[1].wait_for_function("Object.keys(window.__DR.S.entries).length === 16")
    # 한 판 더
    host.click('#btn-again')
    for pg in pages: wait_screen(pg, 's-room')
    # 가로 넘침 확인
    for i, pg in enumerate(pages):
        over = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        assert over <= 0, f'{names[i]} 가로 넘침 {over}'
    browser.close()

print('오류:', errors if errors else '없음')
print('브라우저 시험 끝')
