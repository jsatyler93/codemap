function format_status_badge, status
  compile_opt idl2

  case status of
    'critical': return, '[CRITICAL]'
    'watch': return, '[WATCH]'
    'degrading': return, '[DEGRADING]'
    else: return, '[STABLE]'
  endcase
end

pro print_metric_table, alerts, order
  compile_opt idl2

  for index = 0L, n_elements(order) - 1L do begin
    alert = alerts[order[index]]
    alert_score = alert.score
    flagged_count = alert.flagged
    line = string(index + 1L, format='(I3)') + '  ' + alert.name + '  ' + format_status_badge(alert.status) + $
      '  score=' + string(alert_score, format='(F6.3)') + '  flagged=' + string(flagged_count, format='(I3)') + $
      '  trend=' + alert.trend
    print, line
  endfor
end

pro write_summary_report, root_dir, results
  compile_opt idl2

  summary = results.summary
  alerts = results.alerts
  order = results.order
  report_path = filepath('summary.txt', root_dir=root_dir)
  openw, lun, report_path, /get_lun
  printf, lun, 'CodeMap IDL complex demo summary'
  stable_count = summary.stable
  watch_count = summary.watch
  degrading_count = summary.degrading
  critical_count = summary.critical
  max_score = summary.max_score
  printf, lun, 'stable=' + string(stable_count, format='(I4)')
  printf, lun, 'watch=' + string(watch_count, format='(I4)')
  printf, lun, 'degrading=' + string(degrading_count, format='(I4)')
  printf, lun, 'critical=' + string(critical_count, format='(I4)')
  printf, lun, 'max_score=' + string(max_score, format='(F8.4)')
  printf, lun, ''

  for index = 0L, n_elements(order) - 1L do begin
    alert = alerts[order[index]]
    alert_score = alert.score
    flagged_count = alert.flagged
    printf, lun, alert.name + '|' + alert.status + '|' + alert.trend + '|' + $
      string(alert_score, format='(F8.4)') + '|' + string(flagged_count, format='(I4)')
  endfor

  free_lun, lun
end

pro render_console_report, results, verbose=verbose
  compile_opt idl2

  summary = results.summary
  alerts = results.alerts
  order = results.order
  critical_count = summary.critical
  watch_count = summary.watch
  degrading_count = summary.degrading
  stable_count = summary.stable
  max_score = summary.max_score
  print, '== CodeMap IDL Demo Summary =='
  print, 'critical=', critical_count, 'watch=', watch_count, 'degrading=', degrading_count, 'stable=', stable_count
  if keyword_set(verbose) then print, 'max_score=', max_score
  print_metric_table, alerts, order
end