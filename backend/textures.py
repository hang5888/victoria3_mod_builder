"""Converting the game's textures to images a browser can show.

Supports uncompressed and DXT1/DXT3/DXT5 .dds files, which covers the base
game and most mods. PNG and JPEG files (some mods use them) are passed through.
"""
import struct
import zlib


class UnsupportedTexture(Exception):
    pass


def to_browser_image(data, max_size):
    """Returns (image bytes, content type) for a texture file's contents."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return data, "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return data, "image/jpeg"
    return dds_to_png(data, max_size), "image/png"


def _png(width, height, rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


def _channel_offset(mask):
    if mask == 0:
        return None
    return (mask.bit_length() - 1) // 8


# DXGI formats found in files with a DX10 header: byte offsets of (r, g, b, a)
_DXGI_RAW = {28: (0, 1, 2, 3), 29: (0, 1, 2, 3), 87: (2, 1, 0, 3), 91: (2, 1, 0, 3),
             88: (2, 1, 0, None), 93: (2, 1, 0, None)}
_DXGI_BLOCK = {71: b"DXT1", 72: b"DXT1", 74: b"DXT3", 75: b"DXT3", 77: b"DXT5", 78: b"DXT5"}


def _rgb565(c):
    r, g, b = c >> 11, (c >> 5) & 63, c & 31
    return (r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)


def _block_rows(data, offset, width, height, step, kind):
    """Decode every `step`-th pixel of a DXT-compressed image into RGBA rows."""
    block_size = 8 if kind == b"DXT1" else 16
    color_at = block_size - 8
    blocks_wide = (width + 3) // 4
    xs = range(0, width, step)
    rows = []
    for y in range(0, height, step):
        row = bytearray(len(xs) * 4)
        base = offset + (y >> 2) * blocks_wide * block_size
        shift_y = (y & 3) * 4
        last = -1
        for i, x in enumerate(xs):
            block = x >> 2
            if block != last:
                last = block
                pos = base + block * block_size
                c0, c1, bits = struct.unpack_from("<HHI", data, pos + color_at)
                p0, p1 = _rgb565(c0), _rgb565(c1)
                if c0 > c1 or kind != b"DXT1":
                    palette = (p0 + (255,), p1 + (255,),
                               tuple((2 * a + b) // 3 for a, b in zip(p0, p1)) + (255,),
                               tuple((a + 2 * b) // 3 for a, b in zip(p0, p1)) + (255,))
                else:
                    palette = (p0 + (255,), p1 + (255,),
                               tuple((a + b) // 2 for a, b in zip(p0, p1)) + (255,), (0, 0, 0, 0))
                if kind == b"DXT5":
                    a0, a1 = data[pos], data[pos + 1]
                    alpha_bits = int.from_bytes(data[pos + 2:pos + 8], "little")
                    if a0 > a1:
                        alphas = [a0, a1] + [((8 - n) * a0 + (n - 1) * a1) // 7 for n in range(2, 8)]
                    else:
                        alphas = [a0, a1] + [((6 - n) * a0 + (n - 1) * a1) // 5 for n in range(2, 6)] + [0, 255]
                elif kind == b"DXT3":
                    alpha_bits = int.from_bytes(data[pos:pos + 8], "little")
            index = shift_y + (x & 3)
            r, g, b, a = palette[(bits >> (2 * index)) & 3]
            if kind == b"DXT5":
                a = alphas[(alpha_bits >> (3 * index)) & 7]
            elif kind == b"DXT3":
                a = ((alpha_bits >> (4 * index)) & 15) * 17
            row[i * 4:i * 4 + 4] = bytes((r, g, b, a))
        rows.append(row)
    return rows


def dds_to_png(data, max_size):
    """PNG bytes for a DDS file, scaled down so neither side exceeds max_size."""
    if len(data) < 128 or data[:4] != b"DDS ":
        raise UnsupportedTexture("not a DDS file")
    height, width = struct.unpack_from("<II", data, 12)
    mip_count = struct.unpack_from("<I", data, 28)[0] or 1
    flags, fourcc, bits = struct.unpack_from("<I4sI", data, 80)
    offset, kind, channels, bpp = 128, None, None, 4
    if flags & 0x4:
        if fourcc == b"DX10":
            if len(data) < 148:
                raise UnsupportedTexture("truncated DDS")
            dxgi = struct.unpack_from("<I", data, 128)[0]
            offset = 148
            kind, channels = _DXGI_BLOCK.get(dxgi), _DXGI_RAW.get(dxgi)
        elif fourcc in (b"DXT1", b"DXT3", b"DXT5"):
            kind = fourcc
        if kind is None and channels is None:
            raise UnsupportedTexture("unsupported DDS compression")
    else:
        if bits not in (24, 32):
            raise UnsupportedTexture("unsupported DDS pixel format")
        bpp = bits // 8
        channels = tuple(_channel_offset(m) for m in struct.unpack_from("<4I", data, 92))
        if None in channels[:3]:
            raise UnsupportedTexture("unknown channel layout")
        if bits == 24:
            channels = channels[:3] + (None,)

    def level_size(w, h):
        if kind:
            return ((w + 3) // 4) * ((h + 3) // 4) * (8 if kind == b"DXT1" else 16)
        return w * h * bpp

    # Use the smallest stored mip level that is still at least max_size.
    level = 0
    while (level + 1 < mip_count and max(width, height) // 2 >= max_size
           and offset + level_size(width, height) < len(data)):
        offset += level_size(width, height)
        width, height = max(1, width // 2), max(1, height // 2)
        level += 1
    if width == 0 or height == 0 or offset + level_size(width, height) > len(data):
        raise UnsupportedTexture("truncated DDS")

    step = max(1, -(-max(width, height) // max_size))  # then skip pixels if still too big
    out_w = len(range(0, width, step))
    if kind:
        rows = _block_rows(data, offset, width, height, step, kind)
    else:
        r, g, b, a = channels
        rows = []
        for y in range(0, height, step):
            line = data[offset + y * width * bpp: offset + (y + 1) * width * bpp]
            row = bytearray(out_w * 4)
            row[0::4] = line[r::bpp * step]
            row[1::4] = line[g::bpp * step]
            row[2::4] = line[b::bpp * step]
            row[3::4] = line[a::bpp * step] if a is not None else b"\xff" * out_w
            rows.append(row)
    return _png(out_w, len(rows), rows)
