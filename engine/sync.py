"""Audio fingerprints and a common timeline. Source time = offset + rate * camera A time."""
import numpy as np

HZ = 200


def envelope(runtime, source):
    raw = runtime.run([runtime.binary("ffmpeg"), "-v", "error", "-i", source,
                       "-vn", "-ac", "1", "-af", "aresample=4000:first_pts=0",
                       "-ar", "4000", "-f", "s16le", "-"])
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    frames = samples[: len(samples) // 20 * 20].reshape((-1, 20))
    return np.log1p(np.sqrt(np.mean(frames * frames, axis=1)) / 12)


def estimate(main, other):
    # Multiple independent windows prevent a single repeated sound from locking sync.
    count = min(7 * HZ, len(main) // 4, len(other) // 3)
    if count < 2 * HZ:
        return {"offset": 0, "rate": 1, "confidence": 0, "matches": 0, "mode": "weak"}
    fft_size = 1 << (len(other) + count - 2).bit_length()
    spectrum = np.fft.rfft(other, fft_size)
    sum_other = np.r_[0.0, np.cumsum(other, dtype=np.float64)]
    sq_other = np.r_[0.0, np.cumsum(other * other, dtype=np.float64)]
    window_sum = sum_other[count:] - sum_other[:-count]
    window_sq = sq_other[count:] - sq_other[:-count]
    other_norm = np.sqrt(np.maximum(1e-6, window_sq - window_sum * window_sum / count))
    matches = []
    starts = np.unique(np.linspace(0, len(main) - count, min(12, max(5, len(main) // count))).astype(int))
    for start in starts:
        window = main[start:start + count] - main[start:start + count].mean()
        norm = np.linalg.norm(window)
        if norm < 1:
            continue
        corr = np.fft.irfft(spectrum * np.fft.rfft(window[::-1], fft_size), fft_size)
        corr = corr[count - 1:len(other)] / (other_norm * norm)
        corr[other_norm < 1] = -1
        best = int(np.argmax(corr))
        peak = float(corr[best])
        exclusion = HZ // 3
        corr[max(0, best - exclusion):best + exclusion + 1] = -1
        if peak >= 0.58 and peak - float(np.max(corr)) >= 0.06:
            matches.append((start / HZ, (best - start) / HZ, peak))
    if len(matches) < 2:
        return {"offset": 0, "rate": 1, "confidence": 0, "matches": len(matches), "mode": "weak"}
    points = np.asarray(matches)
    best_mask = np.zeros(len(points), dtype=bool)
    best_score = (0, 0)
    for i, (time_a, offset_a, _) in enumerate(points):
        for time_b, offset_b, _ in points[i + 1:]:
            if time_b - time_a < 1:
                continue
            slope = (offset_b - offset_a) / (time_b - time_a)
            if abs(slope) > 0.015:
                continue
            mask = np.abs(points[:, 1] - (offset_a + slope * (points[:, 0] - time_a))) < 0.055
            score = (int(mask.sum()), float(points[mask, 2].sum()))
            if score > best_score:
                best_mask, best_score = mask, score
    if best_score[0] < 2:
        return {"offset": 0, "rate": 1, "confidence": 0, "matches": len(matches), "mode": "weak"}
    agreed = points[best_mask]
    # A short span establishes offset. An extended baseline is needed for clock drift.
    if len(agreed) >= 3 and np.ptp(agreed[:, 0]) >= 16:
        slope, offset = np.polyfit(agreed[:, 0], agreed[:, 1], 1)
    else:
        slope, offset = 0, np.median(agreed[:, 1])
    return {"offset": float(offset), "rate": float(1 + slope),
            "confidence": float(agreed[:, 2].mean()), "matches": len(agreed), "mode": "auto"}
