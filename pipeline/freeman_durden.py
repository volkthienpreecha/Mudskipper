"""Freeman-Durden (1998) 3-component decomposition on lexicographic covariance.

Inputs are field-averaged LINEAR covariance terms (B3.4: aggregate first, then
decompose): hhhh=<|HH|^2>, hvhv=<|HV|^2>, vvvv=<|VV|^2>, hhvv=<HH VV*> (complex).
Returns (Ps, Pd, Pv) in linear power, negatives clipped to 0.
"""
import numpy as np


def freeman_durden(hhhh, hvhv, vvvv, hhvv):
    hhhh, hvhv, vvvv = (np.asarray(x, dtype="f8") for x in (hhhh, hvhv, vvvv))
    hhvv = np.asarray(hhvv, dtype="c16")
    fv = 3.0 * hvhv                      # volume: random dipoles, <|HV|^2> = fv/3
    pv = 8.0 * fv / 3.0
    A = hhhh - fv
    B = vvvv - fv
    C = hhvv - fv / 3.0
    # data conditioning (as PolSARpro / polsartools): if |C|^2 > A*B the residual is not realizable,
    # so shrink C onto the boundary |C|^2 = A*B instead of letting one component go negative
    with np.errstate(divide="ignore", invalid="ignore"):
        bad = (np.abs(C) ** 2 > A * B) & (A > 0) & (B > 0)
        C = np.where(bad, C * np.sqrt(A * B / np.abs(C) ** 2), C)
    det = A * B - np.abs(C) ** 2
    surf = C.real >= 0                   # surface dominant: alpha = -1
    with np.errstate(divide="ignore", invalid="ignore"):
        fd_s = det / (A + B + 2 * C.real)
        fs_s = B - fd_s
        beta = (C + fd_s) / fs_s
        ps_s = fs_s * (1 + np.abs(beta) ** 2)
        pd_s = fd_s * 2.0                # |alpha|^2 = 1
        fs_d = det / (A + B - 2 * C.real)  # double-bounce dominant: beta = 1
        fd_d = B - fs_d
        alpha = (C - fs_d) / fd_d
        ps_d = fs_d * 2.0
        pd_d = fd_d * (1 + np.abs(alpha) ** 2)
    ps = np.where(surf, ps_s, ps_d)
    pd = np.where(surf, pd_s, pd_d)
    # volume over-estimation: A or B <= 0 -> everything is volume
    over = (A <= 0) | (B <= 0)
    ps = np.where(over, 0.0, ps)
    pd = np.where(over, 0.0, pd)
    pv = np.where(over, hhhh + 2 * hvhv + vvvv, pv)
    clip = lambda x: np.clip(np.nan_to_num(x, nan=0.0), 0, None)
    return clip(ps), clip(pd), clip(pv)


def _self_test():
    # build a covariance from known components and recover them
    fs, beta, fd, alpha, fv = 2.0, 0.3, 1.0, -0.5 + 0.2j, 0.6
    hhhh = fs * abs(beta) ** 2 + fd * abs(alpha) ** 2 + fv
    vvvv = fs + fd + fv
    hhvv = fs * beta + fd * alpha + fv / 3
    hvhv = fv / 3
    # this case has Re(C) > 0 -> surface branch forces alpha=-1, so test a pure-surface + volume case exactly
    ps, pd, pv = freeman_durden(fs * abs(beta) ** 2 + fv, fv / 3, fs + fv, fs * beta + fv / 3)
    assert abs(ps - fs * (1 + beta ** 2)) < 1e-9 and pd < 1e-9 and abs(pv - 8 * fv / 3) < 1e-9, (ps, pd, pv)
    ps, pd, pv = freeman_durden(fd * abs(alpha) ** 2 + fv, fv / 3, fd + fv, fd * alpha + fv / 3)
    assert abs(pd - fd * (1 + abs(alpha) ** 2)) < 1e-9 and ps < 1e-9, (ps, pd, pv)
    tot = hhhh + 2 * hvhv + vvvv
    p = freeman_durden(hhhh, hvhv, vvvv, hhvv)
    assert abs(sum(p) - tot) < 1e-9, (sum(p), tot)  # power is conserved
    print("freeman_durden self-test OK")


if __name__ == "__main__":
    _self_test()
