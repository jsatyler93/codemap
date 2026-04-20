function normalize_series, values
  compile_opt idl2
  centered = values - mean(values)
  if max(abs(centered)) gt 0 then centered = centered / max(abs(centered))
  return, centered
end

function compute_threshold, values
  compile_opt idl2
  smooth_values = smooth(values, 3)
  return, mean(abs(smooth_values)) + 0.25
end

function build_report, values, threshold
  compile_opt idl2
  total = total(abs(values) gt threshold)
  if total gt 5 then level = 'high' else level = 'low'
  return, { level: level, flagged: total, average: mean(values) }
end
