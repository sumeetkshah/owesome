import { ToastHost } from './components/ui'
import CreateGroup from './pages/CreateGroup'
import Group from './pages/Group'
import Home from './pages/Home'
import Report from './pages/Report'
import { useRoute } from './lib/router'

export default function App() {
  const route = useRoute()
  return (
    <>
      {route.name === 'home' && <Home />}
      {route.name === 'new' && <CreateGroup />}
      {route.name === 'group' && <Group key={route.code} code={route.code} />}
      {route.name === 'report' && <Report key={route.code} code={route.code} />}
      <ToastHost />
    </>
  )
}
