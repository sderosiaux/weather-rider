import './style.css'
import { startApp } from './game/app'

const root = document.getElementById('app')
if (!root) throw new Error('#app missing')
startApp(root)
