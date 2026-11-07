#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Пересборка таблицы расписания в index.html из наряда парка.

Наряд — PDF вида «TÖÖKORRALDUS BTO 2, <месяц>»: три колонки на лист
(TÖÖPÄEVAL / LAUPÄEVAL / PÜHAPÄEVAL), в строке — маршрут, очередь (Jrk),
группа, начало и конец каждой смены, перерыв в скобках и часы.

    python tools/build_schedule.py naryad.pdf            # разбор и сверка
    python tools/build_schedule.py naryad.pdf --write     # записать в index.html

Что делает:
  * читает PDF в режиме layout (колонки не слипаются) через pypdf;
  * проверяет разбор итогами самого наряда («Kokku» внизу страницы);
  * накладывает очереди наряда на таблицу из index.html, не трогая очереди
    других парков;
  * сверяет результат заново, не пользуясь номерами очередей из разбора.

Чего НЕ делает: не трогает летнюю таблицу и не кладёт PDF в репозиторий —
в наряде-дневнике бывают фамилии водителей.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
import os

DAYS = ['weekday', 'saturday', 'sunday']
RU = {'weekday': 'будни', 'saturday': 'суббота', 'sunday': 'воскресенье'}
TIME = r'\d{1,2}:\d{2}'
JRK = re.compile(r'^(\d+)(Z?)([LN])$')
BREAK = re.compile(r'^\((%s)-(%s)\)$' % (TIME, TIME))
IS_TIME = re.compile(r'^%s$' % TIME)
# Ночные 91–96 в колонке будней — это ночь с пятницы, а не каждый будний
# день (в воскресной колонке их нет). В будни такие очереди не пишем.
NIGHT = re.compile(r'^9[0-9]$')


def norm(t):
    h, m = t.split(':')
    return '%02d:%02d' % (int(h) % 24, int(m))


def mins(t):
    h, m = t.split(':')
    return int(h) * 60 + int(m)


def hhmm(x):
    return '%d:%02d' % (x // 60, x % 60)


# --------------------------------------------------------------------------
# разбор PDF


def pdf_layout(path):
    try:
        import pypdf
    except ImportError:
        sys.exit('нужен pypdf:  pip install pypdf')
    reader = pypdf.PdfReader(path)
    parts = []
    for page in reader.pages:
        parts.append('=== PAGE ===')
        parts.append(page.extract_text(extraction_mode='layout'))
    return '\n'.join(parts).split('\n')


def header_blocks(line):
    """Центры колонок заголовка: три блока по девять столбцов."""
    toks = [((m.start() + m.end()) / 2.0, m.group())
            for m in re.finditer(r'Liin|Jrk|Grp|Algus|Lõpp|1 vah|2 vah', line)]
    assert len(toks) == 27, 'в заголовке %d столбцов вместо 27: %r' % (len(toks), line)
    return [[c for c, _ in toks[b * 9:(b + 1) * 9]] for b in range(3)]


def which_block(center, blocks):
    for b in range(3):
        if blocks[b][0] - 6 <= center <= blocks[b][8] + 6:
            return b
    return min(range(3), key=lambda b: min(abs(center - blocks[b][0]),
                                           abs(center - blocks[b][8])))


def parse_row(toks, cols):
    """toks: [(центр, текст)]. Время раскладываем по ближайшему столбцу
    заголовка, а не по порядку в строке: у длинных смен второй пары нет."""
    i = 0
    route = toks[i][1]
    i += 1
    if route == 'V':          # ночные V-маршруты: «V 2  1N …»
        route += toks[i][1]   # их часы входят в итоги наряда, в таблицу — нет
        i += 1
    jrk, grp = toks[i][1], toks[i + 1][1]
    i += 2
    rec = {'route': route, 'jrk': jrk, 'grp': grp, 'brk': None}
    slots = {}
    for center, t in toks[i:]:
        mb = BREAK.match(t)
        if mb:
            rec['brk'] = (norm(mb.group(1)), norm(mb.group(2)))
            continue
        if not IS_TIME.match(t):
            return None
        best = min(range(3, 9), key=lambda k: abs(cols[k] - center))
        if best in slots:
            return None
        slots[best] = norm(t)
    rec.update(s1=slots.get(3), e1=slots.get(4), s2=slots.get(5),
               e2=slots.get(6), h1=slots.get(7), h2=slots.get(8))
    return rec if rec['s1'] and rec['e1'] else None


def parse_naryad(lines):
    rows = {d: [] for d in DAYS}
    totals_line = None
    blocks = None
    for line in lines:
        if line.startswith('=== PAGE'):
            blocks = None
            continue
        if 'Liin' in line and 'Algus' in line:
            blocks = header_blocks(line)
            continue
        if blocks is None or not line.strip():
            continue
        if re.search(r'1 vah\s+\d+:\d{2}', line):
            totals_line = line
        if ('TÖÖPÄEVAL' in line or 'vahetus' in line or 'TÖÖKORRALDUS' in line
                or 'Kokku' in line or '1 vah' in line or '2 vah' in line):
            continue
        buckets = {0: [], 1: [], 2: []}
        for m in re.finditer(r'\(%s-%s\)|\S+' % (TIME, TIME), line):
            buckets[which_block((m.start() + m.end()) / 2.0, blocks)].append(
                ((m.start() + m.end()) / 2.0, m.group()))
        for b in range(3):
            if len(buckets[b]) < 5:
                continue
            rec = parse_row(buckets[b], blocks[b])
            if rec:
                rows[DAYS[b]].append(rec)
    return rows, totals_line


def check_totals(rows, lines):
    """Сверка разбора с итогами самого наряда: суммы часов 1-й и 2-й смены."""
    want = {}
    for line in lines:
        for i, m in enumerate(re.finditer(r'1 vah\s+(\d+:\d{2})', line)):
            want.setdefault('1', []).append(m.group(1))
        for i, m in enumerate(re.finditer(r'2 vah\s+(\d+:\d{2})', line)):
            want.setdefault('2', []).append(m.group(1))
    ok = True
    if len(want.get('1', [])) != 3 or len(want.get('2', [])) != 3:
        print('  ! итогов «Kokku» в наряде не нашлось — сверка пропущена')
        return None
    for i, d in enumerate(DAYS):
        got1 = sum(mins(r['h1']) for r in rows[d] if r['h1'])
        got2 = sum(mins(r['h2']) for r in rows[d] if r['h2'])
        exp1, exp2 = want['1'][i], want['2'][i]
        good = hhmm(got1) == exp1 and hhmm(got2) == exp2
        ok = ok and good
        print('  %-11s строк %3d, часы %s + %s, в наряде %s + %s — %s'
              % (RU[d], len(rows[d]), hhmm(got1), hhmm(got2), exp1, exp2,
                 'сходится' if good else 'РАСХОДИТСЯ'))
    return ok


# --------------------------------------------------------------------------
# таблица в index.html


def read_table(html, name):
    i = html.index('const %s = {' % name)
    start = html.index('{', i)
    depth, j = 0, start
    while True:
        if html[j] == '{':
            depth += 1
        elif html[j] == '}':
            depth -= 1
            if depth == 0:
                break
        j += 1
    end = html.index(';', j) + 1
    return i, end, html[start:j + 1]


def table_to_json(literal):
    """Литерал JS -> данные. Разбираем через node, чтобы не писать свой парсер."""
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False,
                                     encoding='utf-8') as f:
        f.write('console.log(JSON.stringify(%s));' % literal)
        tmp = f.name
    try:
        out = subprocess.check_output(['node', tmp], encoding='utf-8')
    finally:
        os.unlink(tmp)
    return json.loads(out)


def entry_js(e):
    parts = []
    for v in ('1', '2'):
        slot = e.get(v)
        if not slot:
            continue
        inner = "s:'%s',e:'%s'" % (slot['s'], slot['e'])
        if slot.get('li'):
            inner += ",li:'%s',lo:'%s'" % (slot['li'], slot['lo'])
        parts.append('%s:{%s}' % (v, inner))
    if e.get('t'):
        parts.append("t:'%s'" % e['t'])
    return '{%s}' % ','.join(parts)


def table_js(table):
    out = ['const SCHEDULES_WINTER = {']
    for d in DAYS:
        out.append('%s: {' % d)
        for route in sorted(table[d], key=int):
            body = ','.join("'%s':%s" % (o, entry_js(table[d][route][o]))
                            for o in sorted(table[d][route], key=int))
            out.append("  '%s':{%s}," % (route, body))
        out.append('},')
    out.append('};')
    return '\n'.join(out)


def merge(table, rows):
    stats = {d: dict(repl=0, add=0, night=0) for d in DAYS}
    for d in DAYS:
        for r in rows[d]:
            m = JRK.match(r['jrk'])
            # V-маршруты (V2, V6 …) в приложение не попадают: поле маршрута
            # принимает только цифры
            if not m or r['route'].startswith('V'):
                continue
            route, order = r['route'], str(int(m.group(1)))
            if d == 'weekday' and NIGHT.match(route):
                stats[d]['night'] += 1
                continue
            entry = {'1': {'s': r['s1'], 'e': r['e1']}}
            if r['brk']:
                entry['1']['li'], entry['1']['lo'] = r['brk']
            if r['s2']:
                entry['2'] = {'s': r['s2'], 'e': r['e2']}
            entry['t'] = m.group(3)
            byroute = table[d].setdefault(route, {})
            stats[d]['repl' if order in byroute else 'add'] += 1
            byroute[order] = entry
    return stats


def verify(table, lines):
    """Сверка «с другой стороны»: ищем очередь по временам строки, а не по
    её номеру. Так ошибка в разборе номера очереди не спрячется."""
    ROW = re.compile(r'(?P<route>\d{1,3})\s+(?P<jrk>\d{1,2}Z?[LN])\s+\d{2,4}\s+'
                     r'(?P<rest>(?:\s*(?:\(%s-%s\)|%s))+)' % (TIME, TIME, TIME))
    cuts, problems, checked = None, [], 0
    for line in lines:
        if line.startswith('=== PAGE'):
            cuts = None
            continue
        if 'Liin' in line and 'Algus' in line:
            cuts = [m.start() for m in re.finditer(r'Liin', line)]
            continue
        if cuts is None:
            continue
        for m in ROW.finditer(line):
            if line[:m.start()].rstrip().endswith('V'):
                continue                      # ночной V-маршрут
            col = 0
            for ci, c in enumerate(cuts):
                if m.start() >= c - 3:
                    col = ci
            d, route, jrk = DAYS[col], m.group('route'), m.group('jrk')
            if d == 'weekday' and NIGHT.match(route):
                continue
            times = [norm(t) for t in re.findall(TIME, m.group('rest'))]
            brk = re.search(r'\((%s)-(%s)\)' % (TIME, TIME), m.group('rest'))
            brk = (norm(brk.group(1)), norm(brk.group(2))) if brk else None
            byroute = table[d].get(route)
            if not byroute:
                problems.append((d, route, jrk, 'маршрута нет в таблице'))
                continue

            def seq(e):
                out = []
                if e.get('1'):
                    out += [e['1']['s'], e['1']['e']]
                if e.get('2'):
                    out += [e['2']['s'], e['2']['e']]
                if e.get('1', {}).get('li'):
                    out += [e['1']['li'], e['1']['lo']]
                return out

            hits = [(o, e) for o, e in byroute.items()
                    if seq(e) and seq(e) == times[:len(seq(e))]]
            if len(hits) != 1:
                problems.append((d, route, jrk, 'очередей с такими временами: %d' % len(hits)))
                continue
            order, entry = hits[0]
            checked += 1
            if order != str(int(re.match(r'^(\d+)', jrk).group(1))):
                problems.append((d, route, jrk, 'времена легли в очередь %s' % order))
            if entry.get('t') != jrk[-1]:
                problems.append((d, route, jrk, 'тип: наряд %s, таблица %s' % (jrk[-1], entry.get('t'))))
            li = entry.get('1', {}).get('li')
            lo = entry.get('1', {}).get('lo')
            if brk and (li, lo) != brk:
                problems.append((d, route, jrk, 'обед: наряд %s, таблица %s' % (brk, (li, lo))))
            if not brk and li:
                problems.append((d, route, jrk, 'обед есть в таблице, в наряде нет'))
    return checked, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf', help='наряд TÖÖKORRALDUS (PDF)')
    ap.add_argument('--write', action='store_true', help='записать результат в index.html')
    ap.add_argument('--index', default=os.path.join(os.path.dirname(__file__), '..', 'index.html'))
    args = ap.parse_args()

    lines = pdf_layout(args.pdf)
    rows, _ = parse_naryad(lines)
    print('Разбор наряда:')
    if check_totals(rows, lines) is False:
        sys.exit('разбор не сошёлся с итогами наряда — дальше идти нельзя')

    html = open(args.index, encoding='utf-8').read()
    i, end, literal = read_table(html, 'SCHEDULES_WINTER')
    table = table_to_json(literal)
    before = sum(len(table[d][r]) for d in DAYS for r in table[d])
    stats = merge(table, rows)
    after = sum(len(table[d][r]) for d in DAYS for r in table[d])
    print('\nНаложение на таблицу (было очередей %d, стало %d):' % (before, after))
    for d in DAYS:
        print('  %-11s заменено %3d, добавлено %2d, ночных пропущено %d'
              % (RU[d], stats[d]['repl'], stats[d]['add'], stats[d]['night']))

    checked, problems = verify(table, lines)
    print('\nОбратная сверка: проверено %d очередей, расхождений %d' % (checked, len(problems)))
    for p in problems[:20]:
        print('   ', p)
    if problems:
        sys.exit('сверка не прошла — в index.html ничего не записано')

    if args.write:
        open(args.index, 'w', encoding='utf-8').write(html[:i] + table_js(table) + html[end:])
        print('\nindex.html обновлён. Проверь diff и прогони ревьюера.')
    else:
        print('\nПрогон без записи. Повтори с --write, чтобы обновить index.html.')


if __name__ == '__main__':
    main()
