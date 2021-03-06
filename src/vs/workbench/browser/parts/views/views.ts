/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/views';
import { Disposable } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { TPromise } from 'vs/base/common/winjs.base';
import { IViewsService, ViewsRegistry, IViewsViewlet, ViewContainer, IViewDescriptor, IViewContainersRegistry, Extensions as ViewContainerExtensions, TEST_VIEWLET_ID } from 'vs/workbench/common/views';
import { Registry } from 'vs/platform/registry/common/platform';
import { ViewletRegistry, Extensions as ViewletExtensions } from 'vs/workbench/browser/viewlet';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { IContextKeyService, IContextKeyChangeEvent, IReadableSet } from 'vs/platform/contextkey/common/contextkey';
import { Event, chain, filterEvent, Emitter } from 'vs/base/common/event';
import { sortedDiff, firstIndex, move } from 'vs/base/common/arrays';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';

function filterViewEvent(container: ViewContainer, event: Event<IViewDescriptor[]>): Event<IViewDescriptor[]> {
	return chain(event)
		.map(views => views.filter(view => view.container === container))
		.filter(views => views.length > 0)
		.event;
}

class CounterSet<T> implements IReadableSet<T> {

	private map = new Map<T, number>();

	add(value: T): CounterSet<T> {
		this.map.set(value, (this.map.get(value) || 0) + 1);
		return this;
	}

	delete(value: T): boolean {
		let counter = this.map.get(value) || 0;

		if (counter === 0) {
			return false;
		}

		counter--;

		if (counter === 0) {
			this.map.delete(value);
		} else {
			this.map.set(value, counter);
		}

		return true;
	}

	has(value: T): boolean {
		return this.map.has(value);
	}
}

interface IViewItem {
	viewDescriptor: IViewDescriptor;
	active: boolean;
}

class ViewDescriptorCollection extends Disposable {

	private contextKeys = new CounterSet<string>();
	private items: IViewItem[] = [];

	private _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get viewDescriptors(): IViewDescriptor[] {
		return this.items
			.filter(i => i.active)
			.map(i => i.viewDescriptor);
	}

	constructor(
		container: ViewContainer,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super();
		const onRelevantViewsRegistered = filterViewEvent(container, ViewsRegistry.onViewsRegistered);
		this._register(onRelevantViewsRegistered(this.onViewsRegistered, this));

		const onRelevantViewsDeregistered = filterViewEvent(container, ViewsRegistry.onViewsDeregistered);
		this._register(onRelevantViewsDeregistered(this.onViewsDeregistered, this));

		const onRelevantContextChange = filterEvent(contextKeyService.onDidChangeContext, e => e.affectsSome(this.contextKeys));
		this._register(onRelevantContextChange(this.onContextChanged, this));

		this.onViewsRegistered(ViewsRegistry.getViews(container));
	}

	private onViewsRegistered(viewDescriptors: IViewDescriptor[]): any {
		let fireChangeEvent = false;

		for (const viewDescriptor of viewDescriptors) {
			const item = {
				viewDescriptor,
				active: this.isViewDescriptorActive(viewDescriptor) // TODO: should read from some state?
			};

			this.items.push(item);

			if (viewDescriptor.when) {
				for (const key of viewDescriptor.when.keys()) {
					this.contextKeys.add(key);
				}
			}

			if (item.active) {
				fireChangeEvent = true;
			}
		}

		if (fireChangeEvent) {
			this._onDidChange.fire();
		}
	}

	private onViewsDeregistered(viewDescriptors: IViewDescriptor[]): any {
		let fireChangeEvent = false;

		for (const viewDescriptor of viewDescriptors) {
			const index = firstIndex(this.items, i => i.viewDescriptor.id === viewDescriptor.id);

			if (index === -1) {
				continue;
			}

			const item = this.items[index];
			this.items.splice(index, 1);

			if (viewDescriptor.when) {
				for (const key of viewDescriptor.when.keys()) {
					this.contextKeys.delete(key);
				}
			}

			if (item.active) {
				fireChangeEvent = true;
			}
		}

		if (fireChangeEvent) {
			this._onDidChange.fire();
		}
	}

	private onContextChanged(event: IContextKeyChangeEvent): any {
		let fireChangeEvent = false;

		for (const item of this.items) {
			const active = this.isViewDescriptorActive(item.viewDescriptor);

			if (item.active !== active) {
				fireChangeEvent = true;
			}

			item.active = active;
		}

		if (fireChangeEvent) {
			this._onDidChange.fire();
		}
	}

	private isViewDescriptorActive(viewDescriptor: IViewDescriptor): boolean {
		return !viewDescriptor.when || this.contextKeyService.contextMatchesRules(viewDescriptor.when);
	}
}

export interface IView {
	viewDescriptor: IViewDescriptor;
	visible: boolean;
}

export interface IViewState {
	visible: boolean;
	collapsed: boolean;
	order?: number;
	size?: number;
}

export interface IViewDescriptorRef {
	viewDescriptor: IViewDescriptor;
	index: number;
}

export interface IAddedViewDescriptorRef extends IViewDescriptorRef {
	collapsed: boolean;
	size?: number;
}

export class ContributableViewsModel extends Disposable {

	readonly viewDescriptors: IViewDescriptor[] = [];
	get visibleViewDescriptors(): IViewDescriptor[] {
		return this.viewDescriptors.filter(v => this.viewStates.get(v.id).visible);
	}

	private _onDidAdd = this._register(new Emitter<IAddedViewDescriptorRef[]>());
	readonly onDidAdd: Event<IAddedViewDescriptorRef[]> = this._onDidAdd.event;

	private _onDidRemove = this._register(new Emitter<IViewDescriptorRef[]>());
	readonly onDidRemove: Event<IViewDescriptorRef[]> = this._onDidRemove.event;

	private _onDidMove = this._register(new Emitter<{ from: IViewDescriptorRef; to: IViewDescriptorRef; }>());
	readonly onDidMove: Event<{ from: IViewDescriptorRef; to: IViewDescriptorRef; }> = this._onDidMove.event;

	constructor(
		container: ViewContainer,
		contextKeyService: IContextKeyService,
		protected viewStates = new Map<string, IViewState>(),
	) {
		super();
		const viewDescriptorCollection = this._register(new ViewDescriptorCollection(container, contextKeyService));

		this._register(viewDescriptorCollection.onDidChange(() => this.onDidChangeViewDescriptors(viewDescriptorCollection.viewDescriptors)));
		this.onDidChangeViewDescriptors(viewDescriptorCollection.viewDescriptors);
	}

	isVisible(id: string): boolean {
		const state = this.viewStates.get(id);

		if (!state) {
			throw new Error(`Unknown view ${id}`);
		}

		return state.visible;
	}

	setVisible(id: string, visible: boolean): void {
		const { visibleIndex, viewDescriptor, state } = this.find(id);

		if (!viewDescriptor.canToggleVisibility) {
			throw new Error(`Can't toggle this view's visibility`);
		}

		if (state.visible === visible) {
			return;
		}

		state.visible = visible;

		if (visible) {
			this._onDidAdd.fire([{ index: visibleIndex, viewDescriptor, size: state.size, collapsed: state.collapsed }]);
		} else {
			this._onDidRemove.fire([{ index: visibleIndex, viewDescriptor }]);
		}
	}

	isCollapsed(id: string): boolean {
		const state = this.viewStates.get(id);

		if (!state) {
			throw new Error(`Unknown view ${id}`);
		}

		return state.collapsed;
	}

	setCollapsed(id: string, collapsed: boolean): void {
		const { state } = this.find(id);
		state.collapsed = collapsed;
	}

	getSize(id: string): number | undefined {
		const state = this.viewStates.get(id);

		if (!state) {
			throw new Error(`Unknown view ${id}`);
		}

		return state.size;
	}

	setSize(id: string, size: number): void {
		const { state } = this.find(id);
		state.size = size;
	}

	move(from: string, to: string): void {
		const fromIndex = firstIndex(this.viewDescriptors, v => v.id === from);
		const toIndex = firstIndex(this.viewDescriptors, v => v.id === to);

		const fromViewDescriptor = this.viewDescriptors[fromIndex];
		const toViewDescriptor = this.viewDescriptors[toIndex];

		move(this.viewDescriptors, fromIndex, toIndex);

		for (let index = 0; index < this.viewDescriptors.length; index++) {
			const state = this.viewStates.get(this.viewDescriptors[index].id);
			state.order = index;
		}

		this._onDidMove.fire({
			from: { index: fromIndex, viewDescriptor: fromViewDescriptor },
			to: { index: toIndex, viewDescriptor: toViewDescriptor }
		});
	}

	private find(id: string): { index: number, visibleIndex: number, viewDescriptor: IViewDescriptor, state: IViewState } {
		for (let i = 0, visibleIndex = 0; i < this.viewDescriptors.length; i++) {
			const viewDescriptor = this.viewDescriptors[i];
			const state = this.viewStates.get(viewDescriptor.id);

			if (viewDescriptor.id === id) {
				return { index: i, visibleIndex, viewDescriptor, state };
			}

			if (state.visible) {
				visibleIndex++;
			}
		}

		throw new Error(`view descriptor ${id} not found`);
	}

	private compareViewDescriptors(a: IViewDescriptor, b: IViewDescriptor): number {
		const viewStateA = this.viewStates.get(a.id);
		const viewStateB = this.viewStates.get(b.id);

		let orderA = viewStateA && viewStateA.order;
		orderA = typeof orderA === 'number' ? orderA : a.order;
		orderA = typeof orderA === 'number' ? orderA : Number.POSITIVE_INFINITY;

		let orderB = viewStateB && viewStateB.order;
		orderB = typeof orderB === 'number' ? orderB : b.order;
		orderB = typeof orderB === 'number' ? orderB : Number.POSITIVE_INFINITY;

		if (orderA !== orderB) {
			return orderA - orderB;
		}

		if (a.id === b.id) {
			return 0;
		}

		return a.id < b.id ? -1 : 1;
	}

	private onDidChangeViewDescriptors(viewDescriptors: IViewDescriptor[]): void {
		const ids = new Set<string>();

		for (const viewDescriptor of this.viewDescriptors) {
			ids.add(viewDescriptor.id);
		}

		viewDescriptors = viewDescriptors.sort(this.compareViewDescriptors.bind(this));

		for (const viewDescriptor of viewDescriptors) {
			if (!this.viewStates.has(viewDescriptor.id)) {
				this.viewStates.set(viewDescriptor.id, {
					visible: true,
					collapsed: viewDescriptor.collapsed
				});
			}
		}

		const splices = sortedDiff<IViewDescriptor>(
			this.viewDescriptors,
			viewDescriptors,
			this.compareViewDescriptors.bind(this)
		).reverse();

		const toRemove: { index: number, viewDescriptor: IViewDescriptor }[] = [];
		const toAdd: { index: number, viewDescriptor: IViewDescriptor, size: number, collapsed: boolean }[] = [];

		for (const splice of splices) {
			const startViewDescriptor = this.viewDescriptors[splice.start];
			let startIndex = startViewDescriptor ? this.find(startViewDescriptor.id).visibleIndex : this.viewDescriptors.length;

			for (let i = 0; i < splice.deleteCount; i++) {
				const viewDescriptor = this.viewDescriptors[splice.start + i];
				const { state } = this.find(viewDescriptor.id);

				if (state.visible) {
					toRemove.push({ index: startIndex++, viewDescriptor });
				}
			}

			for (let i = 0; i < splice.toInsert.length; i++) {
				const viewDescriptor = splice.toInsert[i];
				const state = this.viewStates.get(viewDescriptor.id);

				if (state.visible) {
					toAdd.push({ index: startIndex++, viewDescriptor, size: state.size, collapsed: state.collapsed });
				}
			}
		}

		this.viewDescriptors.splice(0, this.viewDescriptors.length, ...viewDescriptors);

		if (toRemove.length) {
			this._onDidRemove.fire(toRemove);
		}

		if (toAdd.length) {
			this._onDidAdd.fire(toAdd);
		}
	}
}

export class PersistentContributableViewsModel extends ContributableViewsModel {

	private viewletStateStorageId: string;
	private readonly hiddenViewsStorageId: string;

	private storageService: IStorageService;
	private contextService: IWorkspaceContextService;

	constructor(
		container: ViewContainer,
		viewletStateStorageId: string,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService storageService: IStorageService,
		@IWorkspaceContextService contextService: IWorkspaceContextService
	) {
		const hiddenViewsStorageId = `${viewletStateStorageId}.hidden`;
		const viewStates = PersistentContributableViewsModel.loadViewsStates(viewletStateStorageId, hiddenViewsStorageId, storageService, contextService);

		super(container, contextKeyService, viewStates);

		this.viewletStateStorageId = viewletStateStorageId;
		this.hiddenViewsStorageId = hiddenViewsStorageId;
		this.storageService = storageService;
		this.contextService = contextService;

		this._register(this.onDidAdd(() => this.saveVisibilityStates()));
		this._register(this.onDidRemove(() => this.saveVisibilityStates()));
	}

	saveViewsStates(): void {
		const storedViewsStates: { [id: string]: { collapsed: boolean, size: number, order: number } } = {};
		for (const viewDescriptor of this.viewDescriptors) {
			const viewState = this.viewStates.get(viewDescriptor.id);
			if (viewState) {
				storedViewsStates[viewDescriptor.id] = { collapsed: viewState.collapsed, size: viewState.size, order: viewState.order };
			}
		}
		this.storageService.store(this.viewletStateStorageId, JSON.stringify(storedViewsStates), this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? StorageScope.WORKSPACE : StorageScope.GLOBAL);
	}

	private saveVisibilityStates(): void {
		const storedViewsVisibilityStates: { id: string, isHidden: boolean }[] = [];
		for (const viewDescriptor of this.viewDescriptors) {
			if (viewDescriptor.canToggleVisibility) {
				const viewState = this.viewStates.get(viewDescriptor.id);
				storedViewsVisibilityStates.push({ id: viewDescriptor.id, isHidden: viewState ? !viewState.visible : void 0 });
			}
		}
		this.storageService.store(this.hiddenViewsStorageId, JSON.stringify(storedViewsVisibilityStates), StorageScope.GLOBAL);
	}

	private static loadViewsStates(viewletStateStorageId: string, hiddenViewsStorageId: string, storageService: IStorageService, contextService: IWorkspaceContextService): Map<string, IViewState> {
		const viewStates = new Map<string, IViewState>();
		const storedViewsStates = JSON.parse(storageService.get(viewletStateStorageId, contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? StorageScope.WORKSPACE : StorageScope.GLOBAL, '{}'));
		const storedVisibilityStates = <Array<string | { id: string, isHidden: boolean }>>JSON.parse(storageService.get(hiddenViewsStorageId, StorageScope.GLOBAL, '[]'));
		const viewsVisibilityStates = <{ id: string, isHidden: boolean }[]>storedVisibilityStates.map(c => typeof c === 'string' /* migration */ ? { id: c, isHidden: true } : c);
		for (const { id, isHidden } of viewsVisibilityStates) {
			const viewState = storedViewsStates[id];
			// View state should exist always. Add a check if in case does not exist.
			if (viewState) {
				viewStates.set(id, <IViewState>{ ...viewState, ...{ visible: !isHidden } });
			}
		}
		// Migration: Update those not existing in visibility states
		for (const id of Object.keys(storedViewsStates)) {
			if (!viewStates.has(id)) {
				viewStates.set(id, <IViewState>{ ...storedViewsStates[id], ...{ visible: true } });
			}
		}
		return viewStates;
	}

	dispose(): void {
		this.saveViewsStates();
		super.dispose();
	}
}

export class ViewsService extends Disposable implements IViewsService {

	_serviceBrand: any;

	constructor(
		@IInstantiationService private instantiationService: IInstantiationService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IViewletService private viewletService: IViewletService,
		@IStorageService private storageService: IStorageService
	) {
		super();

		const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
		viewContainersRegistry.all.forEach(viewContainer => this.onDidRegisterViewContainer(viewContainer));
		this._register(viewContainersRegistry.onDidRegister(viewContainer => this.onDidRegisterViewContainer(viewContainer)));
		this._register(Registry.as<ViewletRegistry>(ViewletExtensions.Viewlets).onDidRegister(viewlet => this.viewletService.setViewletEnablement(viewlet.id, this.storageService.getBoolean(`viewservice.${viewlet.id}.enablement`, StorageScope.GLOBAL, viewlet.id !== TEST_VIEWLET_ID))));
	}

	openView(id: string, focus: boolean): TPromise<void> {
		const viewDescriptor = ViewsRegistry.getView(id);
		if (viewDescriptor) {
			const viewletDescriptor = this.viewletService.getViewlet(viewDescriptor.container.id);
			if (viewletDescriptor) {
				return this.viewletService.openViewlet(viewletDescriptor.id)
					.then((viewlet: IViewsViewlet) => {
						if (viewlet && viewlet.openView) {
							return viewlet.openView(id, focus);
						}
						return null;
					});
			}
		}
		return TPromise.as(null);
	}

	private onDidRegisterViewContainer(viewContainer: ViewContainer): void {
		const viewDescriptorCollection = this._register(this.instantiationService.createInstance(ViewDescriptorCollection, viewContainer));
		this._register(viewDescriptorCollection.onDidChange(() => this.updateViewletEnablement(viewContainer, viewDescriptorCollection)));
		this.lifecycleService.when(LifecyclePhase.Eventually).then(() => this.updateViewletEnablement(viewContainer, viewDescriptorCollection));
	}

	private updateViewletEnablement(viewContainer: ViewContainer, viewDescriptorCollection: ViewDescriptorCollection): void {
		const enabled = viewDescriptorCollection.viewDescriptors.length > 0;
		this.viewletService.setViewletEnablement(viewContainer.id, enabled);
		this.storageService.store(`viewservice.${viewContainer.id}.enablement`, enabled, StorageScope.GLOBAL);
	}
}