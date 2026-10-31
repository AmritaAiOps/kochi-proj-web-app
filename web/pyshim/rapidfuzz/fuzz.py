"""Pure-Python rapidfuzz.fuzz.ratio: normalized Indel similarity, i.e.
100 * (1 - (len(a) + len(b) - 2 * LCS(a, b)) / (len(a) + len(b))). Category strings are short, so the
O(len(a) * len(b)) LCS is fine. backend/tests/test_rapidfuzz_shim.py checks it
against the real rapidfuzz."""


def ratio(s1, s2, **_kwargs) -> float:
    if s1 is None or s2 is None:
        return 0.0
    a, b = str(s1), str(s2)
    total = len(a) + len(b)
    if total == 0:
        return 100.0
    prev = [0] * (len(b) + 1)
    for ch in a:
        cur = [0]
        for j, other in enumerate(b):
            cur.append(prev[j] + 1 if ch == other else max(prev[j + 1], cur[j]))
        prev = cur
    # same float steps as rapidfuzz (1 - normalized Indel distance), so results match to the last digit
    return (1 - (total - 2 * prev[-1]) / total) * 100
