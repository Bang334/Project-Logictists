"""Script to package algo_lab and optimizer into a compact zip bundle for Google Colab."""

import os
import sys
import zipfile
from pathlib import Path

# Fix Windows console UTF-8 output encoding
if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BUNDLE_OUTPUT = PROJECT_ROOT / "tms_colab_bundle.zip"

EXCLUDE_DIRS = {
    "__pycache__",
    ".pytest_cache",
    ".venv",
    "venv",
    "node_modules",
    ".git",
}

EXCLUDE_EXTS = {
    ".pyc",
    ".pyo",
    ".log",
    ".zip",
}


def should_include(rel_path: Path) -> bool:
    for part in rel_path.parts:
        if part in EXCLUDE_DIRS:
            return False
    if rel_path.suffix in EXCLUDE_EXTS:
        return False
    return True


def package_bundle():
    print(f"📦 Đang đóng gói dữ liệu cho Google Colab từ: {PROJECT_ROOT}")
    count = 0

    with zipfile.ZipFile(BUNDLE_OUTPUT, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for folder_name in ["algo_lab", "optimizer"]:
            folder_path = PROJECT_ROOT / folder_name
            if not folder_path.exists():
                print(f"⚠️ Cảnh báo: Không tìm thấy thư mục {folder_name}")
                continue

            for root, _, files in os.walk(folder_path):
                for file_name in files:
                    full_path = Path(root) / file_name
                    rel_path = full_path.relative_to(PROJECT_ROOT)
                    if should_include(rel_path):
                        zip_file.write(full_path, rel_path.as_posix())
                        count += 1

    size_kb = BUNDLE_OUTPUT.stat().st_size / 1024
    print(f"✅ Đã đóng gói thành công {count} files vào:")
    print(f"👉 {BUNDLE_OUTPUT} ({size_kb:.1f} KB)")
    print("\n🚀 HƯỚNG DẪN SỬ DỤNG TRÊN GOOGLE COLAB:")
    print("1. Mở file 'TMS_Algorithm_Colab.ipynb' hoặc kéo file này vào https://colab.research.google.com/")
    print("2. Chuyển Runtime: Runtime -> Change runtime type -> Chọn CPU High-RAM hoặc T4 GPU")
    print(f"3. Kéo thả file '{BUNDLE_OUTPUT.name}' vào mục Files bên trái của Colab (hoặc dùng Git clone)")
    print("4. Bấm 'Run All' hoặc chạy từng cell để thực hiện benchmark với tốc độ siêu nhanh!\n")


if __name__ == "__main__":
    package_bundle()
