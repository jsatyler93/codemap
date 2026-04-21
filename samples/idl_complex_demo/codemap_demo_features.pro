function compute_gradient_energy, values
  compile_opt idl2

  gradients = abs(values - shift(values, 1))
  gradients[0] = gradients[1]

  return, mean(gradients)
end

function compute_window_stats, values, window_size
  compile_opt idl2

  count = n_elements(values)
  if window_size le 1 then window_size = 2L

  if count lt window_size then begin
    segment = values
    peak = max(segment)
    trough = min(segment)
    stability = mean(abs(segment - mean(segment)))
  endif else begin
    peak = -1.0e30
    trough = 1.0e30
    stability_total = 0.0
    window_counter = 0L

    for start_index = 0L, count - window_size, window_size do begin
      segment = values[start_index:start_index + window_size - 1L]
      if max(segment) gt peak then peak = max(segment)
      if min(segment) lt trough then trough = min(segment)
      stability_total = stability_total + mean(abs(segment - mean(segment)))
      window_counter = window_counter + 1L
    endfor

    stability = stability_total / float(window_counter)
  endelse

  return, {peak: peak, trough: trough, stability: stability, gradient_energy: compute_gradient_energy(values)}
end

function derive_feature_vector, values
  compile_opt idl2

  smoothed = rolling_smooth(values, 2L)
  window = compute_window_stats(smoothed, 4L)

  return, {mean: mean(smoothed), spread: max(smoothed) - min(smoothed), peak: window.peak, trough: window.trough, $
           stability: window.stability, gradient_energy: window.gradient_energy}
end

function score_quality_band, features
  compile_opt idl2

  score = features.gradient_energy + (features.spread * 0.65) + (abs(features.mean) * 0.2)
  if features.stability lt 0.18 then score = score - 0.20 else score = score + 0.10
  if features.peak gt 0.85 then score = score + 0.35

  return, score
end