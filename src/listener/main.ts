import Listener from './Listener.svelte';
import { mount } from 'svelte';
import '../app.css';

mount(Listener, {
	target: document.getElementById('app')!
});
