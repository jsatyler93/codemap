function list_metric_files, root_dir
  compile_opt idl2

  files = file_search(filepath('*.dat', root_dir=root_dir), count=file_count)
  if file_count eq 0 then message, 'No metric files found in ' + root_dir

  return, files[sort(files)]
end

function read_metric_file, file_path
  compile_opt idl2

  sample_count = file_lines(file_path) - 1L
  if sample_count le 0 then message, 'Metric file is empty: ' + file_path

  values = fltarr(sample_count)
  openr, lun, file_path, /get_lun
  readf, lun, metric_name
  for index = 0L, sample_count - 1L do begin
    readf, lun, values[index]
  endfor
  free_lun, lun

  return, {name: metric_name, values: values, sample_count: sample_count, average: mean(values)}
end

function load_workspace, root_dir, verbose=verbose
  compile_opt idl2

  metric_files = list_metric_files(root_dir)
  file_count = n_elements(metric_files)

  first_record = read_metric_file(metric_files[0])
  records = replicate(first_record, file_count)
  records[0] = first_record

  for file_index = 1L, file_count - 1L do begin
    records[file_index] = read_metric_file(metric_files[file_index])
  endfor

  if keyword_set(verbose) then begin
    for file_index = 0L, file_count - 1L do begin
      print, 'Loaded metric:', records[file_index].name, 'mean=', records[file_index].average
    endfor
  endif

  return, records
end