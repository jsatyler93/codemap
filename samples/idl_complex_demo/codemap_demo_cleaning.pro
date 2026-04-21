function interpolate_gaps, values
  compile_opt idl2

  result = float(values)
  missing = where(~finite(result), missing_count)
  if missing_count eq 0 then return, result

  for idx_index = 0L, missing_count - 1L do begin
    target = missing[idx_index]
    left = target - 1L
    while (left ge 0) and (~finite(result[left])) do left = left - 1L

    right = target + 1L
    while (right lt n_elements(result)) and (~finite(result[right])) do right = right + 1L

    if (left ge 0) and (right lt n_elements(result)) then begin
      result[target] = (result[left] + result[right]) / 2.0
    endif else begin
      if left ge 0 then begin
        result[target] = result[left]
      endif else begin
        if right lt n_elements(result) then result[target] = result[right] else result[target] = 0.0
      endelse
    endelse
  endfor

  return, result
end

function clip_outliers, values, sigma_limit
  compile_opt idl2

  result = float(values)
  center = median(result)
  spread = mean(abs(result - center))
  if spread eq 0 then return, result

  low = center - (sigma_limit * spread)
  high = center + (sigma_limit * spread)

  high_hits = where(result gt high, high_count)
  if high_count gt 0 then result[high_hits] = high

  low_hits = where(result lt low, low_count)
  if low_count gt 0 then result[low_hits] = low

  return, result
end

function center_series, values
  compile_opt idl2

  result = float(values) - mean(values)
  scale = max(abs(result))
  if scale gt 0 then result = result / scale

  return, result
end

function rolling_smooth, values, passes
  compile_opt idl2

  result = float(values)
  if passes le 0 then return, result

  pass_index = 0L
  repeat begin
    prior = result
    result = (shift(prior, 1) + prior + shift(prior, -1)) / 3.0
    result[0] = (prior[0] + prior[1]) / 2.0
    result[n_elements(result) - 1L] = (prior[n_elements(prior) - 2L] + prior[n_elements(prior) - 1L]) / 2.0
    pass_index = pass_index + 1L
  endrep until pass_index ge passes

  return, result
end

function sanitize_series, values
  compile_opt idl2

  cleaned = interpolate_gaps(values)
  cleaned = clip_outliers(cleaned, 3.0)
  cleaned = center_series(cleaned)
  cleaned = rolling_smooth(cleaned, 2L)

  return, cleaned
end