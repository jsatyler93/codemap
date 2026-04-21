function describe_trend, values
  compile_opt idl2

  count = n_elements(values)
  edge_count = count / 3L
  if edge_count lt 1L then edge_count = 1L

  leading = mean(values[0:edge_count - 1L])
  trailing = mean(values[count - edge_count:count - 1L])

  if trailing - leading gt 0.20 then return, 'rising'
  if leading - trailing gt 0.20 then return, 'falling'
  return, 'flat'
end

function classify_run, features, score
  compile_opt idl2

  status = 'watch'
  if score lt 1.10 then status = 'stable'
  if score ge 1.70 then status = 'critical'
  if (features.stability gt 0.35) and (status ne 'critical') then status = 'degrading'

  case status of
    'critical': return, 'critical'
    'watch': return, 'watch'
    'degrading': return, 'degrading'
    else: return, 'stable'
  endcase
end

function rank_metrics, alerts
  compile_opt idl2

  return, reverse(sort(alerts.score))
end

function summarize_alerts, alerts
  compile_opt idl2

  summary = {stable: 0L, watch: 0L, degrading: 0L, critical: 0L, max_score: 0.0}

  foreach alert, alerts do begin
    case alert.status of
      'critical': summary.critical = summary.critical + 1L
      'watch': summary.watch = summary.watch + 1L
      'degrading': summary.degrading = summary.degrading + 1L
      else: summary.stable = summary.stable + 1L
    endcase

    if alert.score gt summary.max_score then summary.max_score = alert.score
  endforeach

  return, summary
end

function detect_anomalies, records
  compile_opt idl2

  record_count = n_elements(records)
  template = {name: '', score: 0.0, status: 'stable', flagged: 0L, trend: 'flat', stability: 0.0}
  alerts = replicate(template, record_count)

  for record_index = 0L, record_count - 1L do begin
    cleaned = sanitize_series(records[record_index].values)
    features = derive_feature_vector(cleaned)
    score = score_quality_band(features)
    flagged = long(total(abs(cleaned) gt 0.82))
    alerts[record_index] = {name: records[record_index].name, score: score, status: classify_run(features, score), $
                            flagged: flagged, trend: describe_trend(cleaned), stability: features.stability}
  endfor

  order = rank_metrics(alerts)
  summary = summarize_alerts(alerts)

  return, {alerts: alerts, order: order, summary: summary}
end