#!/usr/bin/env python3
"""elf-inspect.py — 只读 ELF 检查器（零依赖，自解析），用于 libnode.so 选型门禁。

检查项对应 《000-工程规划.md》§5.8 的六项：
  1) e_type / e_machine
  2) PT_INTERP 计数（必须为 0）
  3) DT_NEEDED 清单（是否声明 libc++_shared.so）
  4) 动态符号 node::Start（_ZN4node5StartEiPPc）
  5) .codesign 段是否存在
  6) SHA-256

用法：python elf-inspect.py <file.so>
"""
import hashlib
import struct
import sys


def main(path: str) -> int:
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"\x7fELF":
        print("NOT-ELF")
        return 2
    is64 = data[4] == 2
    le = data[5] == 1
    end = "<" if le else ">"
    if not is64:
        print("32-bit ELF not supported by this checker")
        return 2

    e_type, e_machine = struct.unpack(end + "HH", data[16:20])
    e_phoff, = struct.unpack(end + "Q", data[32:40])
    e_shoff, = struct.unpack(end + "Q", data[40:48])
    e_phentsize, e_phnum = struct.unpack(end + "HH", data[54:58])
    e_shentsize, e_shnum, e_shstrndx = struct.unpack(end + "HHH", data[58:64])

    type_name = {1: "REL", 2: "EXEC", 3: "DYN", 4: "CORE"}.get(e_type, str(e_type))
    mach_name = {0x3E: "x86_64", 0xB7: "AArch64", 0x28: "ARM"}.get(e_machine, hex(e_machine))

    # ---- program headers ----
    phs = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type, = struct.unpack(end + "I", data[off:off + 4])
        if is64:
            p_off, p_va, p_pa, p_fsz, p_msz, p_flags, p_align = struct.unpack(
                end + "QQQQQQQ", data[off + 8:off + 8 + 56])
        else:
            p_off, p_va, p_pa, p_fsz, p_msz, p_flags, p_align = struct.unpack(
                end + "IIIIIII", data[off + 4:off + 4 + 28])
        phs.append((p_type, p_off, p_va, p_fsz, p_msz, p_flags, p_align))
    interp = [p for p in phs if p[0] == 3]
    dyn = [p for p in phs if p[0] == 2]

    # ---- section headers ----
    sections = []
    shstr = b""
    skipped_shdr = 0
    for i in range(e_shnum):
        off = e_shoff + i * e_shentsize
        if off + 64 > len(data):
            skipped_shdr += 1
            continue
        sh_name, sh_type = struct.unpack(end + "II", data[off:off + 8])
        sh_flags, sh_addr, sh_off, sh_size = struct.unpack(end + "QQQQ", data[off + 8:off + 40])
        sh_link, sh_info, sh_align, sh_entsize = struct.unpack_from(end + "IIQQ", data, off + 40)
        sections.append((sh_name, sh_type, sh_flags, sh_addr, sh_off, sh_size, sh_link, sh_info, sh_align, sh_entsize))
    shstr_idx = e_shstrndx if 0 < e_shstrndx < len(sections) else 0
    shstr_hdr = sections[shstr_idx] if sections else None
    if shstr_hdr:
        shstr = data[shstr_hdr[4]:shstr_hdr[4] + shstr_hdr[5]]

    def name_at(idx: int) -> str:
        if idx >= len(shstr):
            return ""
        end_i = shstr.find(b"\x00", idx)
        return shstr[idx:end_i if end_i >= 0 else len(shstr)].decode("utf-8", "replace")

    sec_names = [name_at(s[0]) for s in sections]

    # ---- dynamic entries (DT_NEEDED / SONAME) ----
    needed, soname = [], None
    for p in dyn:
        seg = data[p[1]:p[1] + p[3]]
        # DT_STRTAB value points to a VA; resolve to file offset via phdr mapping
        strtab_va = None
        entries = []
        for k in range(0, len(seg) - 15, 16):
            tag, val = struct.unpack(end + "QQ", seg[k:k + 16])
            entries.append((tag, val))
            if tag == 0:
                break
        for tag, val in entries:
            if tag == 5:  # DT_STRTAB
                strtab_va = val
        if strtab_va is None:
            continue
        strtab_off = None
        for (p_type, p_off, p_va, p_fsz, p_msz, p_flags, p_align) in phs:
            if p_type == 1 and p_va <= strtab_va < p_va + p_fsz:  # PT_LOAD
                strtab_off = p_off + (strtab_va - p_va)
                break
        if strtab_off is None:
            continue
        for tag, val in entries:
            if tag in (1, 14):  # DT_NEEDED, DT_SONAME
                s_off = strtab_off + val
                s_end = data.find(b"\x00", s_off)
                s = data[s_off:s_end].decode("utf-8", "replace")
                if tag == 1:
                    needed.append(s)
                else:
                    soname = s

    # ---- dynamic symbols: node::Start ----
    want = b"_ZN4node5StartEiPPc"
    has_start = want in data  # presence in the dynstr/strtab raw bytes
    # also verify it is an exported FUNC in .dynsym
    dynsym_exported = False
    for idx, s in enumerate(sections):
        if sec_names[idx] == ".dynsym":
            link = s[6]
            strtab_idx = link
            if strtab_idx < len(sections):
                st = sections[strtab_idx]
                strtab = data[st[4]:st[4] + st[5]]
            else:
                strtab = b""
            n = s[5] // s[9] if s[9] else 0
            for j in range(n):
                o = s[4] + j * s[9]
                st_name, st_info, st_other, st_shndx, st_value, st_size = struct.unpack(end + "IBBHQQ", data[o:o + 24])
                if st_name and st_name < len(strtab):
                    e = strtab.find(b"\x00", st_name)
                    nm = strtab[st_name:e]
                    if nm == want and st_shndx != 0:
                        dynsym_exported = True
    codesign = any("codesign" in nm for nm in sec_names)
    ohos_ident = ".note.ohos.ident" in sec_names

    print(f"file            : {path}")
    print(f"size            : {len(data):,} bytes ({len(data)/1048576:.1f} MiB)")
    print(f"sha256          : {hashlib.sha256(data).hexdigest()}")
    print(f"e_type          : {type_name} ({e_type})")
    print(f"e_machine       : {mach_name} ({hex(e_machine)})")
    print(f"PT_INTERP       : {len(interp)}   <-- 必须为 0")
    print(f"SONAME          : {soname}")
    print(f"DT_NEEDED ({len(needed)}): {', '.join(needed)}")
    print(f"has libc++_shared: {any('libc++_shared' in n for n in needed)}")
    print(f"node::Start sym : raw={has_start} exported_dynsym={dynsym_exported}")
    print(f".codesign sec   : {codesign}   |  .note.ohos.ident: {ohos_ident}")
    print(f"shdr            : e_shoff={e_shoff} e_shnum={e_shnum} e_shentsize={e_shentsize} parsed={len(sections)} skipped={skipped_shdr}")
    print(f"sections        : {len(sec_names)}")
    verdict = []
    if e_type != 3:
        verdict.append("e_type != ET_DYN")
    if e_machine != 0xB7:
        verdict.append("e_machine != AArch64")
    if interp:
        verdict.append("PT_INTERP present (PIE!)")
    if not dynsym_exported:
        verdict.append("node::Start not exported")
    print("VERDICT         : " + ("PASS (可 dlopen 的真共享库)" if not verdict else "FAIL -> " + "; ".join(verdict)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
