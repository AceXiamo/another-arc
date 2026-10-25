import { describe, expect, it } from 'vitest'
import { fileKind } from '@shared/file-kind'

describe('fileKind', () => {
  it('maps common extensions, case-insensitively', () => {
    expect(fileKind('archive-2026.zip')).toBe('archive')
    expect(fileKind('backup.tar.gz')).toBe('archive')
    expect(fileKind('Report.PDF')).toBe('pdf')
    expect(fileKind('photo.HEIC')).toBe('image')
    expect(fileKind('clip.mov')).toBe('video')
    expect(fileKind('song.flac')).toBe('audio')
    expect(fileKind('installer.dmg')).toBe('disk')
    expect(fileKind('setup.pkg')).toBe('disk')
    expect(fileKind('notes.docx')).toBe('document')
    expect(fileKind('budget.xlsx')).toBe('spreadsheet')
    expect(fileKind('data.csv')).toBe('spreadsheet')
    expect(fileKind('main.tsx')).toBe('code')
  })

  it('falls back to the MIME type when the extension is missing or unknown', () => {
    expect(fileKind('download', 'image/png')).toBe('image')
    expect(fileKind('download', 'application/pdf')).toBe('pdf')
    expect(fileKind('file.bin', 'application/x-apple-diskimage')).toBe('disk')
    expect(fileKind('sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet')
    expect(fileKind('doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document')
    expect(fileKind('readme', 'text/plain')).toBe('document')
  })

  it('prefers the extension over the MIME type, and defaults to generic', () => {
    expect(fileKind('page.html', 'application/octet-stream')).toBe('code')
    expect(fileKind('blob', 'application/octet-stream')).toBe('generic')
    expect(fileKind('.bashrc')).toBe('generic')
    expect(fileKind('trailing.')).toBe('generic')
    expect(fileKind('constructor')).toBe('generic')
    expect(fileKind('x.constructor')).toBe('generic')
  })
})
