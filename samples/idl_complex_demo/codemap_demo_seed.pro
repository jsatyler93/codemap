function build_demo_waveform, metric_index, sample_count, phase_shift, inject_spike=inject_spike
  compile_opt idl2

  t = findgen(sample_count)
  baseline = 0.15 * float(metric_index)

  case metric_index of
    0: values = sin((t + phase_shift) / 3.0) + baseline
    1: values = (0.6 * cos((t + phase_shift) / 4.0)) + (0.15 * sin(t / 2.0)) + baseline
    2: values = (0.3 * sin((t + phase_shift) / 2.0)) + (t / float(sample_count)) + baseline
    else: values = (0.2 * cos((t + phase_shift) / 5.0)) + baseline
  endcase

  values = values + ((metric_index + 1.0) * 0.03 * sin(t / 1.7))
  if keyword_set(inject_spike) then begin
    spike_index = 4L + ((metric_index * 5L) mod (sample_count - 6L))
    values[spike_index:spike_index + 1L] = values[spike_index:spike_index + 1L] + 1.1
  endif

  return, float(values)
end

pro write_demo_metric_file, file_path, metric_name, values
  compile_opt idl2

  openw, lun, file_path, /get_lun
  printf, lun, metric_name
  for index = 0L, n_elements(values) - 1L do begin
    printf, lun, string(values[index], format='(F10.5)')
  endfor
  free_lun, lun
end

pro ensure_demo_workspace, root_dir
  compile_opt idl2

  metric_names = ['temperature', 'pressure', 'vibration', 'throughput']

  if ~file_test(root_dir, /directory) then file_mkdir, root_dir

  existing = file_search(filepath('*.dat', root_dir=root_dir), count=file_count)
  if file_count ge n_elements(metric_names) then return

  for metric_index = 0L, n_elements(metric_names) - 1L do begin
    file_path = filepath(metric_names[metric_index] + '.dat', root_dir=root_dir)
    values = build_demo_waveform(metric_index, 24L, metric_index * 0.75, inject_spike=(metric_index eq 2L))
    write_demo_metric_file, file_path, metric_names[metric_index], values
  endfor
end