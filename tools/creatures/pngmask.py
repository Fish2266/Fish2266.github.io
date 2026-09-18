# Minimal PNG -> binary mask decoder (8-bit, non-interlaced). Pure Python.
import zlib, struct, sys

def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat = 8, b''
    while pos < len(data):
        ln, = struct.unpack('>I', data[pos:pos + 4]); typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]; pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct, cm, fm, il = struct.unpack('>IIBBBBB', chunk)
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
    assert bd == 8 and il == 0, (bd, il)
    ch = {6: 4, 2: 3, 0: 1, 4: 2}[ct]
    raw = zlib.decompress(idat)
    stride = w * ch
    prev = bytearray(stride)
    i = 0
    mask = []
    for y in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        if f == 1:
            for x in range(ch, stride): line[x] = (line[x] + line[x - ch]) & 255
        elif f == 2:
            for x in range(stride): line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 255
        prev = line
        if ch == 4:   row = bytes(1 if line[x * 4 + 3] > 127 else 0 for x in range(w))
        elif ch == 2: row = bytes(1 if line[x * 2 + 1] > 127 else 0 for x in range(w))
        elif ch == 3: row = bytes(1 if line[x * 3] + line[x * 3 + 1] + line[x * 3 + 2] < 384 else 0 for x in range(w))
        else:         row = bytes(1 if line[x] < 128 else 0 for x in range(w))
        mask.append(row)
    return w, h, ct, mask

if __name__ == '__main__':
    for name in sys.argv[1:]:
        w, h, ct, m = read_png(name + '.png')
        ink = sum(sum(r) for r in m)
        with open(name + '.mask', 'wb') as f:
            f.write(struct.pack('>II', w, h))
            for r in m: f.write(r)
        print(f'{name}: {w}x{h} colortype={ct} ink={ink / (w * h):.1%}')
