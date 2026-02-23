from pathlib import Path
import re
import sys

schema_path = Path("prisma/schema.prisma")
bak_path = Path("prisma/schema.prisma.autobak")

txt = schema_path.read_text(encoding="utf-8")

# Backup (only once if not exists)
if not bak_path.exists():
    bak_path.write_text(txt, encoding="utf-8")

orig = txt

# ---- Fix 1: Membership field line accidentally concatenated ----
# Example bad: userId     StringbusinessId String
txt = re.sub(
    r'(?m)^\s*userId\s+StringbusinessId\s+String\s*$',
    '  userId     String\n  businessId String',
    txt
)

# Also handle variants like: userId StringbusinessId String
txt = re.sub(
    r'(?m)^\s*userId\s+StringbusinessId\s+String\s*$',
    '  userId     String\n  businessId String',
    txt
)

# ---- Fix 2: Service model: remove wrong single-@ lines like @([businessId]) ----
txt = re.sub(r'(?m)^\s*@\(\[.*\]\)\s*$', '', txt)

# ---- Helper: ensure model block contains specific model-level attributes ----
def patch_model_block(text: str, model_name: str, patch_fn):
    pattern = re.compile(rf'(?ms)^model\s+{re.escape(model_name)}\s*\{{.*?^\}}', re.MULTILINE)
    m = pattern.search(text)
    if not m:
        return text, False
    block = m.group(0)
    new_block = patch_fn(block)
    if new_block == block:
        return text, False
    return text[:m.start()] + new_block + text[m.end():], True

def ensure_lines_before_closing_brace(block: str, lines):
    # Insert missing lines right before last closing brace of the model
    if not block.rstrip().endswith("}"):
        return block
    existing = set(re.findall(r'(?m)^\s*@@\w+\(.*\)\s*$', block))
    to_add = [ln for ln in lines if ln not in existing]
    if not to_add:
        return block
    # Ensure there is a blank line before attributes for readability
    block_lines = block.splitlines()
    # Find last line with "}"
    idx = len(block_lines) - 1
    while idx >= 0 and block_lines[idx].strip() != "}":
        idx -= 1
    if idx < 0:
        return block
    # Insert
    insert_at = idx
    # Add a blank line if previous line isn't blank
    if insert_at > 0 and block_lines[insert_at-1].strip() != "":
        block_lines.insert(insert_at, "")
        insert_at += 1
    for ln in to_add:
        block_lines.insert(insert_at, "  " + ln.strip())
        insert_at += 1
    return "\n".join(block_lines) + ("\n" if not block.endswith("\n") else "")

# ---- Fix 3: Service model: ensure enterprise constraints ----
def patch_service(block: str):
    # Ensure correct model-level attributes
    wanted = [
        "@@index([businessId])",
        "@@index([businessId, active])",
        "@@unique([businessId, name])",
    ]
    # Remove any malformed single @ attributes already stripped globally; just ensure @@ ones exist
    return ensure_lines_before_closing_brace(block, wanted)

txt, _ = patch_model_block(txt, "Service", patch_service)

# ---- Fix 4: Staff model: remove @unique on userId, add @@unique([userId, businessId]) ----
def patch_staff(block: str):
    # Replace "userId String @unique" with "userId String"
    block = re.sub(r'(?m)^\s*userId\s+String\s+@unique\s*$', '  userId     String', block)
    # If userId line exists but alignment differs, remove @unique safely
    block = re.sub(r'(?m)^(\s*userId\s+String)\s+@unique\s*$', r'\1', block)
    wanted = ["@@unique([userId, businessId])"]
    return ensure_lines_before_closing_brace(block, wanted)

txt, _ = patch_model_block(txt, "Staff", patch_staff)

# ---- Cleanup multiple blank lines (keep it readable) ----
txt = re.sub(r'\n{3,}', '\n\n', txt)

schema_path.write_text(txt, encoding="utf-8")

print("✅ schema.prisma repaired")
print(f"Backup saved at: {bak_path}")
if txt == orig:
    print("ℹ️ No changes were necessary (already ok).")
