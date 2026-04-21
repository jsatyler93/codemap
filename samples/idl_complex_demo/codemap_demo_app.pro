function analyze_workspace, root_dir, verbose=verbose
  compile_opt idl2

  records = load_workspace(root_dir, verbose=verbose)
  return, detect_anomalies(records)
end

pro codemap_demo_main, root_dir, verbose=verbose
  compile_opt idl2

  on_error, 2

  if n_elements(root_dir) eq 0 then root_dir = filepath('codemap_demo_workspace', root_dir='.')

  ensure_demo_workspace, root_dir
  results = analyze_workspace(root_dir, verbose=verbose)
  render_console_report, results, verbose=verbose
  write_summary_report, root_dir, results

  if keyword_set(verbose) then print, 'Wrote report:', filepath('summary.txt', root_dir=root_dir)
end