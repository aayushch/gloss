import { mount } from 'svelte';
import '../shared/pages.css';
import Ask from './Ask.svelte';

mount(Ask, { target: document.getElementById('app')! });
