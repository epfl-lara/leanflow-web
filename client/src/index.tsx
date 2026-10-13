import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'

import { Studio } from './studio/Studio'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Studio />
  </StrictMode>,
)
