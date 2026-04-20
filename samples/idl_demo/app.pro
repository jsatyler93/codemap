pro idl_demo_app, values, /verbose
  compile_opt idl2

  if n_elements(values) eq 0 then begin
    message, 'No values supplied'
    return
  endif

  cleaned = normalize_series(values)
  threshold = compute_threshold(cleaned)
  report = build_report(cleaned, threshold)

  if keyword_set(verbose) then begin
    print, 'Threshold:', threshold
  endif else begin
    print, 'Summary mode enabled'
  endelse

  case report.level of
    'high': print, 'High variance run'
    'low': print, 'Low variance run'
    else: print, 'Nominal run'
  endcase

  render_report, report
end
