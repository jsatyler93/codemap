pro render_report, report
  compile_opt idl2
  keys = ['level', 'flagged', 'average']
  foreach key, keys do begin
    print, format_bucket_label(key), report.(key)
  endforeach
end

function format_bucket_label, name
  compile_opt idl2
  return, strupcase(name)
end
