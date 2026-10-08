"""Independent standard-library OOXML verification of the production round-trip."""
import importlib.util
import json
import sys
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

sys.dont_write_bytecode = True

source = Path(__file__).parent / "phase1g" / "xml_check.py"
spec = importlib.util.spec_from_file_location("phase1g_xml", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.OUTPUT = Path(__file__).resolve().parents[2] / ".cache" / "phase1gr1-results"
result = module.check("Tiger-XLSX-Roundtrip.xlsx", True)
with ZipFile(module.OUTPUT / "Tiger-XLSX-Roundtrip.xlsx") as archive:
    sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    styles = ET.fromstring(archive.read("xl/styles.xml"))
    cell = sheet.find("s:sheetData/s:row/s:c[@r='A1']", module.NS)
    xf = styles.findall("s:cellXfs/s:xf", module.NS)[int(cell.attrib["s"])]
    font = styles.findall("s:fonts/s:font", module.NS)[int(xf.attrib["fontId"])]
    assert font.find("s:color", module.NS).attrib["rgb"] == "FF2244AA"
result["RGBfontColor"] = "PASS"
print(json.dumps({"productionIndependentOOXML": result}, ensure_ascii=False, indent=2))
