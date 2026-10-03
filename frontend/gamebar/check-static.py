#!/usr/bin/env python3
"""Source/resource checks only. Does not compile C#, XAML or PowerShell."""
import argparse
import glob
from pathlib import Path
import re
import struct
import urllib.request
import wave
import xml.etree.ElementTree as ET
import zlib

ROOT = Path(__file__).resolve().parent
WIDGET = ROOT / "Widget"
MS = {"m": "http://schemas.microsoft.com/developer/msbuild/2003"}
P = {"p": "http://schemas.microsoft.com/appx/manifest/foundation/windows10"}
OFFICIAL = ("https://raw.githubusercontent.com/microsoft/XboxGameBarSamples/"
            "master/Samples/WidgetAdvSampleCS/Package.appxmanifest")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_png(path, expected):
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", str(path))
    offset, dimensions, image, ended = 8, None, bytearray(), False
    while offset < len(data):
        require(offset + 12 <= len(data), "Truncated PNG chunk")
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + size + 12
        require(end <= len(data), "Truncated PNG payload")
        payload = data[offset + 8:end - 4]
        crc = struct.unpack_from(">I", data, end - 4)[0]
        require(zlib.crc32(kind + payload) & 0xffffffff == crc, "PNG CRC mismatch")
        if kind == b"IHDR":
            require(offset == 8 and size == 13, "Invalid PNG header")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            dimensions = (width, height)
            require((depth, color, compression, filtering, interlace) == (8, 6, 0, 0, 0), "Expected RGBA8 PNG")
        elif kind == b"IDAT":
            image.extend(payload)
        elif kind == b"IEND":
            require(size == 0 and end == len(data), "Invalid PNG end")
            ended = True
        offset = end
    require(ended and dimensions == expected, "PNG dimensions/end mismatch: " + path.name)
    pixels = zlib.decompress(image)
    stride = expected[0] * 4 + 1
    require(len(pixels) == stride * expected[1], "PNG scanline size mismatch")
    require(all(pixels[i] <= 4 for i in range(0, len(pixels), stride)), "Invalid PNG filter")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-official", action="store_true", help="Fetch current official proxy manifest for comparison")
    args = parser.parse_args()
    xml_files = [p for p in ROOT.rglob("*") if p.suffix in
                 {".xaml", ".csproj", ".appxmanifest", ".xml", ".config"}
                 and not {"bin", "obj", "AppPackages"}.intersection(p.relative_to(ROOT).parts)]
    for path in xml_files:
        ET.parse(path)
    project = ET.parse(WIDGET / "FantasyHub.GameBar.Widget.csproj")
    # @(Name) 形式的 Include 要先找到 Name 自己声明的输入（BuildBridge 就是先把 Bridge
    # 产物收进 BridgePayload 再整体搬进 Content，见 csproj 里的注释）。不这样跳一层，
    # 检查器会把 "@(BridgePayload)" 当文件名，报一个假的「Missing project input」。
    declared = {}
    for item in project.findall(".//m:*", MS):
        include = item.get("Include")
        if include:
            declared.setdefault(item.tag.split("}")[-1], []).extend(include.split(";"))
    for tag in ("Compile", "Page", "ApplicationDefinition", "AppxManifest", "Content"):
        for item in project.findall(".//m:" + tag, MS):
            include = item.get("Include", "")
            reference = re.fullmatch(r"@\(([\w.]+)\)", include)
            if reference:
                include = ";".join(declared.get(reference.group(1), []))
            # 逐个 glob 检查（原来整串一次 glob 时，带分号的多模式其实永远匹配不上）。
            # 含 $(...) 的跳过：那是生成物路径，由 Windows 打包脚本负责，见 HANDOFF.txt。
            for pattern in include.split(";"):
                if not pattern or "$(" in pattern:
                    continue
                require(bool(glob.glob(str(WIDGET / pattern.replace("\\", "/")))),
                        "Missing project input: " + pattern)
    packages = {x.get("Include"): x.get("Version") for x in project.findall(".//m:PackageReference", MS)}
    require(packages.get("Microsoft.NETCore.UniversalWindowsPlatform") == "6.2.9", "UWP version drift")
    require(packages.get("Microsoft.Gaming.XboxGameBar") == "7.2.240903001", "Game Bar version drift")
    release = [g for g in project.findall("m:PropertyGroup", MS) if "Release" in g.get("Condition", "")]
    require(len(release) == 1 and release[0].findtext("m:UseDotNetNativeToolchain", namespaces=MS) == "true", "Release must use .NET Native")
    logos = {"StoreLogo.png": (50, 50), "Square44x44Logo.png": (44, 44),
             "Square150x150Logo.png": (150, 150), "SplashScreen.png": (620, 300)}
    for name, dimensions in logos.items():
        check_png(WIDGET / "Assets" / name, dimensions)
    sounds = ("click", "done", "tdp-up", "tdp-down")
    for name in sounds:
        with wave.open(str(ROOT.parent.parent / "public" / "sounds" / (name + ".wav")), "rb") as sound:
            require(sound.getnframes() > 0 and sound.getframerate() > 0, "Empty WAV")
    event_count = 0
    for xaml in WIDGET.glob("*.xaml"):
        code = Path(str(xaml) + ".cs").read_text(encoding="utf-8")
        for element in ET.parse(xaml).iter():
            for key, value in element.attrib.items():
                if key in {"Click", "ItemClick", "SelectionChanged", "ValueChanged", "Loaded", "Unloaded"}:
                    require(re.search(r"\b" + re.escape(value) + r"\s*\(", code), "Missing XAML handler: " + value)
                    event_count += 1
    manifest = ET.parse(WIDGET / "Package.appxmanifest")
    for element in manifest.iter():
        for key, value in element.attrib.items():
            if key in {"Square150x150Logo", "Square44x44Logo", "Image"}:
                require((WIDGET / value.replace("\\", "/")).is_file(), "Missing manifest image")
    if args.check_official:
        with urllib.request.urlopen(OFFICIAL, timeout=20) as response:
            official = ET.fromstring(response.read())
        def proxies(tree):
            return {(node.get("ClassId").upper(), node.findtext("p:Path", namespaces=P),
                     tuple(sorted((i.get("Name"), i.get("InterfaceId").upper()) for i in node.findall("p:Interface", P))))
                    for node in tree.findall(".//p:ProxyStub", P)}
        require(proxies(manifest) == proxies(official), "Official proxy ClassId/Path/interface drift")
        print("Official proxy ClassId, Path and interfaces matched (live master).")
    print("PASS: XML=%d, PNG=%d, WAV=%d, XAML handlers=%d; project inputs and package versions checked."
          % (len(xml_files), len(logos), len(sounds), event_count))
    print("NOT CHECKED: Windows compilation, .NET Native, PowerShell execution, packaging, device behavior, Rust integration.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit("FAIL: " + str(error))