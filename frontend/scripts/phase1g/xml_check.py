"""Independent, read-only OOXML assertions using Python's standard library."""
import json
import sys
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / '.cache' / 'phase1g-results'
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def check(filename, expect_styles):
    with ZipFile(OUTPUT / filename) as archive:
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        sheets = workbook.findall('s:sheets/s:sheet', NS)
        assert [sheet.attrib['name'] for sheet in sheets] == ['工作表1', '資料表']
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            strings = [''.join(node.itertext()) for node in shared.findall('s:si', NS)]
        main = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        cells = {node.attrib['r']: node for node in main.findall('s:sheetData/s:row/s:c', NS)}

        def text(address):
            cell = cells[address]
            assert cell.attrib['t'] in ('s', 'inlineStr', 'str')
            if cell.attrib['t'] == 's':
                return strings[int(cell.find('s:v', NS).text)]
            return ''.join(cell.find('s:is', NS).itertext()) if cell.attrib['t'] == 'inlineStr' else cell.find('s:v', NS).text

        assert [text(address) for address in ['C1', 'C2', 'C3']] == ['00123', '0912345678', '01234567']
        assert text('B1') == '台中公司'
        assert text('B5') == '=1+1'
        for address, value in [('A1', 10), ('A2', 20), ('D1', 0.25), ('E1', 1234.5), ('F1', 46303)]:
            assert float(cells[address].find('s:v', NS).text) == value
        second = ET.fromstring(archive.read('xl/worksheets/sheet2.xml'))
        assert float(second.find('s:sheetData/s:row/s:c/s:v', NS).text) == 100
        assert cells['A3'].find('s:f', NS).text == 'SUM(A1:A2)'
        assert cells['I1'].find('s:f', NS).text == '資料表!A1'
        assert float(cells['A3'].find('s:v', NS).text) == 30
        assert float(cells['I1'].find('s:v', NS).text) == 100
        assert main.find('s:mergeCells/s:mergeCell', NS).attrib['ref'] == 'G1:H1'
        assert float(main.find('s:sheetData/s:row', NS).attrib['ht']) == 30
        columns = main.findall('s:cols/s:col', NS)
        assert any(int(col.attrib['min']) <= 2 <= int(col.attrib['max']) and abs(float(col.attrib['width']) - 24) < 0.01 for col in columns)
        styles = ET.fromstring(archive.read('xl/styles.xml'))
        formats = {int(node.attrib['numFmtId']): node.attrib['formatCode'] for node in styles.findall('s:numFmts/s:numFmt', NS)}
        xfs = styles.findall('s:cellXfs/s:xf', NS)

        def xf(address):
            return xfs[int(cells[address].attrib.get('s', 0))]

        for address, pattern in [('D1', '0.00%'), ('E1', '"NT$"#,##0.00'), ('F1', 'yyyy-mm-dd')]:
            num_id = int(xf(address).attrib['numFmtId'])
            assert formats.get(num_id, {10: '0.00%'}.get(num_id)) == pattern
        if expect_styles:
            font = styles.findall('s:fonts/s:font', NS)[int(xf('A1').attrib['fontId'])]
            assert font.find('s:b', NS) is not None
            assert font.find('s:name', NS).attrib['val'] == 'Calibri'
            assert float(font.find('s:sz', NS).attrib['val']) == 11
            fill = styles.findall('s:fills/s:fill', NS)[int(xf('B1').attrib['fillId'])]
            assert fill.find('s:patternFill/s:fgColor', NS).attrib['rgb'] == 'FFFFF2CC'
            border = styles.findall('s:borders/s:border', NS)[int(xf('C1').attrib['borderId'])]
            assert border.find('s:bottom', NS).attrib['style'] == 'thin'
            assert border.find('s:bottom/s:color', NS).attrib['rgb'] == 'FFFF0000'
            assert xf('G1').find('s:alignment', NS).attrib['horizontal'] == 'center'
            assert xf('G1').find('s:alignment', NS).attrib['vertical'] == 'center'
            assert xf('G1').find('s:alignment', NS).attrib['wrapText'] == '1'
        return {'values_text_formulas_sheets_formats_merge_dimensions': 'PASS', 'common_styles': 'PASS' if expect_styles else 'KNOWN_LOSS'}


if __name__ == '__main__':
    results = {name: check(name, styles) for name, styles in [('exceljs-roundtrip.xlsx', True), ('sheetjs-roundtrip.xlsx', False)]}
    print(json.dumps({'independentOOXML': results}, ensure_ascii=False, indent=2))
    sys.exit(0)
