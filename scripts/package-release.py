#!/usr/bin/env python3
"""Create an app distribution with an explicit allowlist; never bundle local records."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib

root = Path(__file__).resolve().parents[1]
output = root / "entregables"
output.mkdir(exist_ok=True)
archive = output / "Circulos_2027_Aplicacion.zip"
files = [
    "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "index.html",
    "Dockerfile", "compose.yaml", ".dockerignore", ".gitignore", "README.md",
    "INSTRUCCIONES_PARA_ABRIR.txt", "ABRIR_APP_WINDOWS.bat", "DETENER_APP_WINDOWS.bat", "abrir-app.sh",
]
folders = ["src", "server", "shared", "public", "scripts", "tests", "docs", "dist"]
selected = [root / name for name in files]
for folder in folders:
    selected.extend(path for path in (root / folder).rglob("*") if path.is_file() and "__pycache__" not in path.parts)
missing = [str(path.relative_to(root)) for path in selected if not path.is_file()]
if missing:
    raise SystemExit("Faltan archivos para empaquetar: " + ", ".join(missing))

with ZipFile(archive, "w", compression=ZIP_DEFLATED, compresslevel=9) as package:
    for path in sorted(selected):
        relative = path.relative_to(root)
        if relative.parts[0] in {"data", ".git", ".tools", "node_modules", ".env", "entregables"}:
            raise SystemExit("Archivo privado fuera de la distribución permitida")
        content = path.read_bytes()
        if path.suffix == ".bat":
            content = content.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        package.writestr(str(Path("Circulos_2027") / relative), content)

digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / "SHA256SUMS.txt").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
print(f"Paquete creado: {archive}")
print(f"Tamaño: {archive.stat().st_size:,} bytes; archivos: {len(selected)}")
print(f"SHA-256: {digest}")
