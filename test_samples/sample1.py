def simulate(N, r0, L0, method='sinc'):
    delta = 0.02
    cn = np.random.randn(N, N)

    if method == 'sinc':
        stencil = build_stencil(delta, L0)
        phi = sinc_generate(stencil, cn)
        phi *= np.sqrt(r0)
    else:
        PSD = von_karman(r0, L0)
        phi = np.fft.ifft2(cn * np.sqrt(PSD)).real

    psf = np.abs(np.fft.fft2(phi))**2
    psf /= psf.sum()
    return psf
