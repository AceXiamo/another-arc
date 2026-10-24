// Shaped like Arc's StorableSidebar.json: flat [id, object, …] lists, items
// linked through childrenIds, spaces naming their pinned / unpinned containers.

const tab = (id: string, url: string, title: string | null = null, savedTitle = `saved ${id}`) => [
  id,
  { id, title, childrenIds: [], data: { tab: { savedURL: url, savedTitle } } }
]
const list = (id: string, title: string, children: string[]) => [id, { id, title, childrenIds: children, data: { list: {} } }]
const holder = (id: string, children: string[]) => [id, { id, childrenIds: children, data: { itemContainer: {} } }]

export function fixture() {
  return {
    sidebar: {
      containers: [
        { global: {} },
        {
          spaces: [
            'personal',
            {
              title: null,
              profile: { default: true },
              containerIDs: ['unpinned', 'u1', 'pinned', 'p1'],
              customInfo: {
                windowTheme: { primaryColorPalette: { midTone: { red: 0.2, green: 0.5, blue: 0.95, alpha: 1 } } }
              }
            },
            'work',
            {
              title: ' Work ',
              profile: { custom: { _0: { directoryBasename: 'Profile 1' } } },
              containerIDs: ['unpinned', 'u2', 'pinned', 'p2']
            },
            'empty',
            { title: 'Empty', profile: { default: true }, containerIDs: ['unpinned', 'u3', 'pinned', 'p3'] }
          ],
          items: [
            ...holder('p1', ['f1', 't1', 'note', 'internal', 'split']),
            ...holder('u1', ['today1', 'today2']),
            ...list('f1', 'Reading', ['t2', 'f2']),
            ...list('f2', 'Papers', ['t3']),
            ...tab('t1', 'https://one.test/', 'Renamed One'),
            ...tab('t2', 'https://two.test/'),
            ...tab('t3', 'https://three.test/a?b=c'),
            ...['note', { id: 'note', childrenIds: [], data: { easel: {} } }],
            ...tab('internal', 'arc://boosts'),
            ...['split', { id: 'split', childrenIds: ['s1', 's2'], data: { splitView: {} } }],
            ...tab('s1', 'https://left.test/'),
            ...tab('s2', 'https://right.test/'),
            ...tab('today1', 'https://today.test/'),
            ...tab('today2', 'https://today2.test/'),
            ...holder('p2', ['w1']),
            ...tab('w1', 'https://work.test/'),
            ...holder('p3', []),
            ...holder('fav-default', ['fav1']),
            ...tab('fav1', 'https://fav.test/', 'Fav'),
            ...holder('fav-p1', [])
          ],
          topAppsContainerIDs: [{ default: true }, 'fav-default', { custom: { _0: { directoryBasename: 'Profile 1' } } }, 'fav-p1']
        }
      ]
    }
  }
}
