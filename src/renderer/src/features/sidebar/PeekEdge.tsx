import { LAYOUT } from '@shared/layout'
import { useUi } from '../../stores/ui'

/**
 * With the sidebar collapsed, the left gutter is the only shell area beside
 * the page. Hovering it reveals the sidebar as a floating panel; the top
 * gutter doubles as the window drag region.
 */
export function PeekEdge() {
  return (
    <>
      <div className="drag absolute left-0 right-0 top-0" style={{ height: LAYOUT.gutter }} />
      <div
        className="absolute bottom-0 left-0 top-0 z-20"
        style={{ width: LAYOUT.gutter }}
        onPointerEnter={() => useUi.setState({ peek: true })}
      />
    </>
  )
}
