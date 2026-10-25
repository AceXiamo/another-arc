// File type of a download, for its icon. Decided by extension first (that is
// what the user sees in the name), then by MIME type.

export type FileKind =
  | 'archive'
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'disk'
  | 'document'
  | 'spreadsheet'
  | 'code'
  | 'generic'

const BY_EXTENSION: Record<string, FileKind> = {}
const add = (kind: FileKind, list: string) => {
  for (const ext of list.split(' ')) BY_EXTENSION[ext] = kind
}
add('archive', 'zip 7z rar tar gz tgz bz2 tbz tbz2 xz txz zst lz lzma z cab jar war apk xpi crx')
add('pdf', 'pdf')
add('image', 'png jpg jpeg jfif gif webp avif heic heif bmp tif tiff svg ico icns psd raw cr2 nef dng')
add('video', 'mp4 m4v mov webm mkv avi wmv flv mpg mpeg 3gp ogv')
add('audio', 'mp3 m4a aac wav flac ogg oga opus aif aiff alac wma mid midi')
add('disk', 'dmg pkg mpkg iso img app exe msi deb rpm appimage')
add('document', 'doc docx odt rtf txt md markdown pages epub mobi tex log key ppt pptx odp')
add('spreadsheet', 'xls xlsx xlsm ods csv tsv numbers')
add(
  'code',
  'js mjs cjs ts tsx jsx json jsonc html htm css scss less xml yaml yml toml ini sh zsh bash py rb go rs java kt swift c h cc cpp hpp cs php lua sql vue svelte wasm ipynb'
)

/** MIME prefixes and exact types, checked in order. */
const BY_MIME: Array<[test: string, kind: FileKind]> = [
  ['image/', 'image'],
  ['video/', 'video'],
  ['audio/', 'audio'],
  ['application/pdf', 'pdf'],
  ['application/zip', 'archive'],
  ['application/x-7z', 'archive'],
  ['application/x-rar', 'archive'],
  ['application/x-tar', 'archive'],
  ['application/gzip', 'archive'],
  ['application/x-gzip', 'archive'],
  ['application/x-bzip', 'archive'],
  ['application/x-xz', 'archive'],
  ['application/zstd', 'archive'],
  ['application/x-apple-diskimage', 'disk'],
  ['application/x-iso9660-image', 'disk'],
  ['application/vnd.apple.installer', 'disk'],
  ['application/x-msdownload', 'disk'],
  ['application/x-msi', 'disk'],
  ['application/vnd.ms-excel', 'spreadsheet'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml', 'spreadsheet'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'spreadsheet'],
  ['text/csv', 'spreadsheet'],
  ['application/msword', 'document'],
  ['application/vnd.openxmlformats-officedocument', 'document'],
  ['application/vnd.oasis.opendocument', 'document'],
  ['application/rtf', 'document'],
  ['application/epub', 'document'],
  ['application/json', 'code'],
  ['application/javascript', 'code'],
  ['application/xml', 'code'],
  ['text/html', 'code'],
  ['text/css', 'code'],
  ['text/javascript', 'code'],
  ['text/xml', 'code'],
  ['text/', 'document']
]

export function fileKind(filename: string, mimeType = ''): FileKind {
  const dot = filename.lastIndexOf('.')
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot + 1).toLowerCase()
    const kind = Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : undefined
    if (kind) return kind
  }
  const mime = mimeType.toLowerCase()
  if (mime) for (const [test, kind] of BY_MIME) if (mime.startsWith(test)) return kind
  return 'generic'
}
