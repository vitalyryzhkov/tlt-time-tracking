# -*- coding: utf-8 -*-
"""Сборка данных парковки из таблицы парка.

Вход — «Korrektne tabel K62a trassid» в xlsx: лист `Trassid`, по блоку на
трассу, в блоке столбец мест и прижатый к нему столбец бортов. Строки блока
идут строка в строку: место слева и место справа в одной строке таблицы стоят
друг напротив друга. Отсюда и берётся «напротив», арифметики над номерами тут
нет — у трассы 2 пара «58 ↔ 57», у трассы 5 «208 ↔ 213».

    python tools/build_park.py tabel.xlsx [--write] [--buses]

Без --write печатает отчёт и ничего не трогает. Без --buses расстановка
«борт -> место» в index.html не попадает: репозиторий публичный, а таблица
парка — внутренний документ. Саму таблицу в репозиторий не класть.
"""
import io
import os
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit('нужен openpyxl: pip install openpyxl')

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, 'index.html')
START = '// --- PARK DATA START (tools/build_park.py) ---'
END = '// --- PARK DATA END ---'

# (трасса, столбец мест, столбец бортов). Первый столбец трассы — тот ряд,
# который на плане нарисован снизу, второй — верхний.
COLUMNS = [
    (1, 2, 1), (1, 4, 5),
    (2, 8, 7), (2, 10, 11),
    (3, 14, 13), (3, 16, 17),
    (4, 20, 19), (4, 22, 23),
    (5, 26, 25), (5, 28, 29),
    (6, 32, 31), (6, 33, 34),
    (7, 36, 35), (7, 37, 38),
    (8, 40, 39),
    (9, 43, 42), (9, 45, 46),
    (10, 47, 48),
    (11, 51, 50),
    (12, 52, 53),
]

# Геометрия — с фотографий плана (AS Signaal, 28.10.2021), в таблице её нет.
# island — полоса зарядки и заправки между рядами: автобусы стоят к ней носом.
# entry: 'right' — в трассу заезжают с правого по схеме конца.
# flip — на плане ряды идут не в том порядке, в каком стоят столбцы таблицы:
#   чётный ряд нарисован сверху. Переворот сохраняет пары «напротив», потому
#   что меняет местами ряды целиком, не трогая позиции внутри них.
# across=False — пары из таблицы для этой трассы на план не ложатся.
META = {
    1:  dict(island='VA-7', note='P15 · P11 · P4', entry='right', flip=True, across=False,
             labels=['нечётные: 29–23 в углу, 21–1 наискось', 'чётные']),
    2:  dict(island='VA-6', note='P14', entry='right', flip=True,
             labels=['нечётные', 'чётные']),
    3:  dict(island='VA-4 / VA-5', note='P26 · P15 · P8', entry='right', flip=True,
             labels=['нечётные', 'чётные']),
    4:  dict(island='VA-3', note='P24', entry='right', flip=True,
             labels=['нечётные', 'чётные']),
    5:  dict(island='VA-2', note='P28', entry='right', flip=True,
             labels=['нечётные', 'чётные']),
    6:  dict(island='VA-1', note='P28 · P19', entry='right', flip=True,
             labels=['нечётные', 'чётные']),
    7:  dict(island='', note='P25 · P19 · P8 · P5', flip=True,
             labels=['длинный ряд', 'короткий ряд, чётные'],
             warn='Ряды 7-й трассы очень разной длины: 13 мест против 44. '
                  'Что напротив чего, взято из таблицы парка и на плане '
                  'не проверено.'),
    8:  dict(note='P10 · P7 · P4',
             rows=[('P10, ряд 1', 316, 325), ('P10, ряд 2', 326, 335),
                   ('P7', 336, 342), ('P4', 343, 346)]),
    9:  dict(island='', note='P13 · P11', labels=['чётные', 'нечётные']),
    10: dict(note='P10', labels=['ряд']),
    11: dict(note='P10, два участка', labels=['ряд'],
             warn='На плане 11-я трасса — два участка по 10 мест со сдвигом, '
                  'а в таблице парка это один список из 20. Как они стоят '
                  'друг относительно друга, я не проверил.'),
    12: dict(note='центр парка', labels=['по таблице парка'],
             warn='Трассу 12 я на плане крупно не видел: список и порядок мест '
                  'взяты из таблицы парка, а как они стоят на земле — не проверено.'),
}

# warn — что именно на этой трассе под вопросом. Показывается на экране.
META[1]['warn'] = ('Нечётный ряд 1-й трассы разорван: 21–1 стоят наискось вдоль '
                   'зарядки, а 29–23 — отдельной группой в углу слева. Поэтому '
                   'место напротив тут не показываю, а счёт «от въезда» идёт '
                   'по всему ряду, вместе с угловой четвёркой.')

# Место есть на плане, но в таблице парка не подписано.
EXTRA_SLOTS = {8: [('335', 19)]}

# Шапка таблицы занимает первые строки; ниже начинаются блоки трасс.
FIRST_DATA_ROW = 4

SLOT_RE = re.compile(r'^(\d{1,3}(?:/\d)?)(?: ?[NL])?$')
# Шире, чем нужно сейчас (борта в парке четырёхзначные): так проверка на
# столкновение с номерами мест не станет мёртвой, если в таблице появится
# трёхзначный борт.
BUS_RE = re.compile(r'^\d{3,5}E?$')


def cell(ws, row, col):
    v = ws.cell(row=row, column=col).value
    return '' if v is None else str(v).strip()


def read(path):
    ws = openpyxl.load_workbook(path, data_only=True)['Trassid']
    lanes, buses, bus_rows = {}, {}, {}
    for lane, c_slot, c_bus in COLUMNS:
        col = []
        for r in range(FIRST_DATA_ROW, ws.max_row + 1):
            raw = cell(ws, r, c_slot)
            m = SLOT_RE.match(raw)
            if not m:
                continue
            slot = m.group(1)
            col.append(slot)
            bus = cell(ws, r, c_bus)
            if BUS_RE.match(bus):
                buses.setdefault(bus, slot)
                bus_rows.setdefault(bus, []).append(slot)
        lanes.setdefault(lane, []).append(col)
    for lane, places in EXTRA_SLOTS.items():
        for slot, at in places:
            lanes[lane][0].insert(at, slot)
    return lanes, buses, bus_rows


def check(lanes, buses, bus_rows):
    problems, warnings = [], []
    seen = {}
    for lane, cols in lanes.items():
        if lane not in META:
            problems.append('трасса %s есть в таблице, но не описана в META' % lane)
            continue
        meta = META[lane]
        if 'rows' not in meta and len(meta['labels']) != len(cols):
            problems.append('трасса %s: в таблице %d столбцов мест, а подписей %d'
                            % (lane, len(cols), len(meta['labels'])))
        for i, col in enumerate(cols):
            if not col:
                problems.append('трасса %s: столбец %d пустой' % (lane, i + 1))
            for s in col:
                if s in seen:
                    problems.append('место %s сразу в трассах %s и %s' % (s, seen[s], lane))
                seen[s] = lane
    for lane, cols in lanes.items():
        # Ряды в таблице выровнены по верхней строке блока, поэтому короткий
        # ряд должен быть вторым: иначе «напротив» по позиции уедет.
        if len(cols) == 2 and len(cols[1]) > len(cols[0]):
            problems.append('трасса %s: второй столбец мест длиннее первого — '
                            'в таблице так не бывает, скорее всего съехали столбцы' % lane)
    for bus, slot in buses.items():
        if slot not in seen:
            problems.append('борт %s стоит на месте %s, которого нет в трассах' % (bus, slot))
        if bus.isdigit() and int(bus) <= 449:
            problems.append('борт %s путается с номером места' % bus)
    for bus in sorted(bus_rows):
        where = sorted(set(bus_rows[bus]))
        if len(where) > 1:
            # Какая из записей свежая — из таблицы не видно, поэтому такой борт
            # из поиска убираем: лучше «не найден», чем чужая трасса ночью.
            warnings.append('борт %s записан сразу на местах %s — убран из поиска'
                            % (bus, ', '.join(where)))
            buses.pop(bus, None)
    return problems, warnings, seen


def js_list(items):
    return '[' + ', '.join("'%s'" % s for s in items) + ']'


def build_js(lanes, buses, with_buses):
    out = [START, 'const PARK_LANES = [']
    for lane in sorted(lanes):
        meta = META[lane]
        cols = lanes[lane]
        if 'rows' in meta:
            flat = cols[0]
            rows = []
            for label, lo, hi in meta['rows']:
                rows.append((label, [str(v) for v in range(lo, hi + 1) if str(v) in flat]))
            assert sum(len(r[1]) for r in rows) == len(flat), \
                'трасса %s: ряды не покрывают список мест' % lane
        else:
            rows = list(zip(meta['labels'], cols))
            if meta.get('flip'):
                rows = rows[::-1]
        head = "  { n: %d, note: '%s'" % (lane, meta['note'])
        if meta.get('island') is not None:
            head += ", island: '%s'" % meta['island']
        if meta.get('entry'):
            head += ", entry: '%s'" % meta['entry']
        if meta.get('across') is False:
            head += ', across: false'
        if meta.get('warn'):
            head += ",\n    warn: '%s'" % meta['warn']
        out.append(head + ', rows: [')
        for label, slots in rows:
            out.append("      { label: '%s', slots: %s }," % (label, js_list(slots)))
        out.append('    ] },')
    out.append('];')
    out.append('')
    if with_buses:
        out.append('const PARK_BUSES = {')
        line = ' '
        for bus in sorted(buses):
            piece = " '%s': '%s'," % (bus, buses[bus])
            if len(line) + len(piece) > 96:
                out.append(line)
                line = ' '
            line += piece
        out.append(line.rstrip(','))
        out.append('};')
    else:
        out.append('// Расстановка бортов по местам в репозиторий не идёт:')
        out.append('// это внутренний документ парка, а сайт публичный. Ждёт')
        out.append('// шифрования, см. SESSION-HANDOFF. Собрать с ней:')
        out.append('// python tools/build_park.py tabel.xlsx --write --buses')
        out.append('const PARK_BUSES = {};')
    out.append(END)
    return '\n'.join(out)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    lanes, buses, bus_rows = read(sys.argv[1])
    problems, warnings, seen = check(lanes, buses, bus_rows)
    print('трасс: %d, мест: %d, бортов: %d' % (len(lanes), len(seen), len(buses)))
    for lane in sorted(lanes):
        print('  трасса %-2d: %s' % (lane, ' | '.join(
            '%d мест (%s..%s)' % (len(c), c[0], c[-1]) for c in lanes[lane] if c)))
    if warnings:
        print('\nПредупреждения:')
        for w in warnings:
            print(' -', w)
    if problems:
        print('\nПРОБЛЕМЫ:')
        for p in problems:
            print(' -', p)
        print('\nразбор не сошёлся, ничего не записано')
        sys.exit(1)
    js = build_js(lanes, buses, '--buses' in sys.argv)
    if '--write' not in sys.argv:
        print('\n(--write не указан, index.html не тронут)')
        print(js[:400] + '\n...')
        return
    src = open(HTML, encoding='utf-8').read()
    a, b = src.index(START), src.index(END) + len(END)
    open(HTML, 'w', encoding='utf-8').write(src[:a] + js + src[b:])
    print('\nindex.html обновлён')


if __name__ == '__main__':
    main()
