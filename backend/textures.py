"""Converting the game's textures to images a browser can show.

Supports uncompressed, DXT1/DXT3/DXT5 and BC7 .dds files, which covers the
base game and the mods seen so far. PNG and JPEG files (some mods use them)
are passed through.
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
_DXGI_BLOCK = {71: b"DXT1", 72: b"DXT1", 74: b"DXT3", 75: b"DXT3", 77: b"DXT5", 78: b"DXT5",
               98: b"BC7", 99: b"BC7"}


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


# ---------------------------------------------------------------------- BC7
# Tables from the BC7 format specification (Direct3D 11).

# Per mode: subsets, partition bits, rotation bits, index selection bits, color bits,
# alpha bits, p-bit per endpoint, p-bit shared per subset, index bits, second index bits.
_BC7_MODES = (
    (3, 4, 0, 0, 4, 0, 1, 0, 3, 0),
    (2, 6, 0, 0, 6, 0, 0, 1, 3, 0),
    (3, 6, 0, 0, 5, 0, 0, 0, 2, 0),
    (2, 6, 0, 0, 7, 0, 1, 0, 2, 0),
    (1, 0, 2, 1, 5, 6, 0, 0, 2, 3),
    (1, 0, 2, 0, 7, 8, 0, 0, 2, 2),
    (1, 0, 0, 0, 7, 7, 1, 0, 4, 0),
    (2, 6, 0, 0, 5, 5, 1, 0, 2, 0),
)
_BC7_WEIGHTS = {
    2: (0, 21, 43, 64),
    3: (0, 9, 18, 27, 37, 46, 55, 64),
    4: (0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64),
}
# Two subsets: bit i is the subset of pixel i.
_BC7_PARTITIONS2 = (
    0xCCCC, 0x8888, 0xEEEE, 0xECC8, 0xC880, 0xFEEC, 0xFEC8, 0xEC80,
    0xC800, 0xFFEC, 0xFE80, 0xE800, 0xFFE8, 0xFF00, 0xFFF0, 0xF000,
    0xF710, 0x008E, 0x7100, 0x08CE, 0x008C, 0x7310, 0x3100, 0x8CCE,
    0x088C, 0x3110, 0x6666, 0x366C, 0x17E8, 0x0FF0, 0x718E, 0x399C,
    0xAAAA, 0xF0F0, 0x5A5A, 0x33CC, 0x3C3C, 0x55AA, 0x9696, 0xA55A,
    0x73CE, 0x13C8, 0x324C, 0x3BDC, 0x6996, 0xC33C, 0x9966, 0x0660,
    0x0272, 0x04E4, 0x4E40, 0x2720, 0xC936, 0x936C, 0x39C6, 0x639C,
    0x9336, 0x9CC6, 0x817E, 0xE718, 0xCCF0, 0x0FCC, 0x7744, 0xEE22,
)
# Three subsets: character i is the subset of pixel i.
_BC7_PARTITIONS3 = (
    "0011001102212222", "0001001122112221", "0000200122112211", "0222002200110111",
    "0000000011221122", "0011001100220022", "0022002211111111", "0011001122112211",
    "0000000011112222", "0000111111112222", "0000111122222222", "0012001200120012",
    "0112011201120112", "0122012201220122", "0011011211221222", "0011200122002220",
    "0001001101121122", "0111001120012200", "0000112211221122", "0022002200221111",
    "0111011102220222", "0001000122212221", "0000001101220122", "0000110022102210",
    "0122012200110000", "0012001211222222", "0110122112210110", "0000011012211221",
    "0022110211020022", "0110011020022222", "0011012201220011", "0000200022112221",
    "0000000211221222", "0222002200120011", "0011001200220222", "0120012001200120",
    "0000111122220000", "0120120120120120", "0120201212010120", "0011220011220011",
    "0011112222000011", "0101010122222222", "0000000021212121", "0022112200221122",
    "0022001100220011", "0220122102201221", "0101222222220101", "0000212121212121",
    "0101010101012222", "0222011102220111", "0002111200021112", "0000211221122112",
    "0222011101110222", "0002111211120002", "0110011001102222", "0000000021122112",
    "0110011022222222", "0022001100110022", "0022112211220022", "0000000000002112",
    "0002000100020001", "0222122202221222", "0101222222222222", "0111201122012220",
)
# Pixels whose index is stored with one bit less: pixel 0 for the first subset, these for the others.
_BC7_ANCHORS2 = (
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
    15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
    15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
    6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
)
_BC7_ANCHORS3_SECOND = (
    3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3,
    3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
    8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15,
    3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
)
_BC7_ANCHORS3_THIRD = (
    15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8,
    15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
    15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8,
    15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
)


def _bc7_expand(value, bits, pbit):
    if pbit is not None:
        value, bits = value << 1 | pbit, bits + 1
    value <<= 8 - bits
    return value | value >> bits


def _bc7_block(block):
    """The 16 RGBA pixels of one 16-byte BC7 block, row by row."""
    value = int.from_bytes(block, "little")
    mode = (value & -value).bit_length() - 1  # the lowest set bit picks the mode
    if not 0 <= mode < 8:
        return [(0, 0, 0, 0)] * 16  # reserved: decoders output transparent black
    pos = mode + 1

    def read(bits):
        nonlocal pos
        result = (value >> pos) & ((1 << bits) - 1)
        pos += bits
        return result

    subsets, partition_bits, rotation_bits, selector_bits, color_bits, alpha_bits, \
        endpoint_pbits, shared_pbits, index_bits, index2_bits = _BC7_MODES[mode]
    partition, rotation, selector = read(partition_bits), read(rotation_bits), read(selector_bits)
    count = subsets * 2  # endpoints, ordered subset 0 start/end, subset 1 start/end, ...
    colors = [[read(color_bits) for _ in range(count)] for _channel in range(3)]
    alphas = [read(alpha_bits) for _ in range(count)] if alpha_bits else None
    if endpoint_pbits:
        pbits = [read(1) for _ in range(count)]
    elif shared_pbits:
        shared = [read(1) for _ in range(subsets)]
        pbits = [shared[e // 2] for e in range(count)]
    else:
        pbits = [None] * count
    endpoints = [[_bc7_expand(colors[c][e], color_bits, pbits[e]) for c in range(3)]
                 + [_bc7_expand(alphas[e], alpha_bits, pbits[e]) if alphas else 255]
                 for e in range(count)]

    if subsets == 1:
        subset_of, anchors = [0] * 16, (0,)
    elif subsets == 2:
        bits = _BC7_PARTITIONS2[partition]
        subset_of, anchors = [bits >> i & 1 for i in range(16)], (0, _BC7_ANCHORS2[partition])
    else:
        subset_of = [int(c) for c in _BC7_PARTITIONS3[partition]]
        anchors = (0, _BC7_ANCHORS3_SECOND[partition], _BC7_ANCHORS3_THIRD[partition])
    indices = [read(index_bits - (i in anchors)) for i in range(16)]
    indices2 = [read(index2_bits - (i == 0)) for i in range(16)] if index2_bits else indices

    weights, weights2 = _BC7_WEIGHTS[index_bits], _BC7_WEIGHTS[index2_bits or index_bits]
    pixels = []
    for i in range(16):
        start, end = endpoints[2 * subset_of[i]], endpoints[2 * subset_of[i] + 1]
        color_weight, alpha_weight = weights[indices[i]], weights2[indices2[i]]
        if selector:
            color_weight, alpha_weight = alpha_weight, color_weight
        pixel = [((64 - color_weight) * start[c] + color_weight * end[c] + 32) >> 6 for c in range(3)]
        pixel.append(((64 - alpha_weight) * start[3] + alpha_weight * end[3] + 32) >> 6)
        if rotation:
            pixel[rotation - 1], pixel[3] = pixel[3], pixel[rotation - 1]
        pixels.append(tuple(pixel))
    return pixels


def _bc7_rows(data, offset, width, height, step):
    """Decode every `step`-th pixel of a BC7 image into RGBA rows."""
    blocks_wide = (width + 3) // 4
    xs = range(0, width, step)
    rows, decoded, block_row = [], {}, -1
    for y in range(0, height, step):
        if y >> 2 != block_row:
            block_row, decoded = y >> 2, {}
        base = offset + block_row * blocks_wide * 16
        row = bytearray(len(xs) * 4)
        for i, x in enumerate(xs):
            pixels = decoded.get(x >> 2)
            if pixels is None:
                pos = base + (x >> 2) * 16
                pixels = decoded[x >> 2] = _bc7_block(data[pos:pos + 16])
            row[i * 4:i * 4 + 4] = bytes(pixels[(y & 3) * 4 + (x & 3)])
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
    if kind == b"BC7":
        rows = _bc7_rows(data, offset, width, height, step)
    elif kind:
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
