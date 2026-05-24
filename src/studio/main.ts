import Studio from './Studio.svelte';
import { mount } from 'svelte';
import '../app.css';

mount(Studio, {
	target: document.getElementById('app')!
});
