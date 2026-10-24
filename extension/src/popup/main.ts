// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

import { mount } from 'svelte';
import '../shared/pages.css';
import Popup from './Popup.svelte';

mount(Popup, { target: document.getElementById('app')! });
