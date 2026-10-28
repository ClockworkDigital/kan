"""GitHub-owned label definitions and assignments, separate from field conflicts."""

import re
from urllib.error import HTTPError


def github_labels(labels):
    """Validate the complete snapshot before changing any Kan labels."""
    if not isinstance(labels, list):
        raise ValueError('Expected a GitHub label list')
    result = {}
    for label in labels:
        if not isinstance(label, dict):
            raise ValueError('Expected expanded GitHub labels')
        identity = label.get('id')
        name, colour = label.get('name'), label.get('color')
        if (type(identity) is not int or identity <= 0 or not isinstance(name, str)
                or not 1 <= len(name) <= 50):
            raise ValueError('Invalid GitHub label identity or name')
        identity = str(identity)
        if not isinstance(colour, str) or not re.fullmatch(r'[0-9a-fA-F]{6}', colour):
            raise ValueError('Invalid GitHub label colour')
        if identity in result:
            raise ValueError('Duplicate GitHub label identity')
        result[identity] = {'name': name, 'colourCode': '#' + colour.lower()}
    return result


def owned_label_ids(saved):
    return [identity for entry in saved.get('labels', {}).values()
            for identity in ([entry['publicId']] if entry.get('publicId') else [])
            + entry.get('retiredPublicIds', [])]


def validate_label_ownership(boards, repositories):
    """Reject conflicting protected mappings before making any requests."""
    if len(boards.values()) != len(set(boards.values())):
        raise RuntimeError('Duplicate repository board ownership in state')
    owners = []
    for repository, saved in repositories.items():
        if repository not in boards or saved.get('board') != boards[repository]:
            raise RuntimeError('Label mapping belongs to a different board')
        owners.extend(owned_label_ids(saved))
    if len(owners) != len(set(owners)):
        raise RuntimeError('Duplicate Kan label ownership in state')


def sync_labels(kan, board, source, saved, save):
    """Keep stable source IDs; never adopt or delete an unrelated Kan label."""
    if saved.setdefault('board', board['publicId']) != board['publicId']:
        raise RuntimeError('Label mapping belongs to a different board')
    mappings = saved.setdefault('labels', {})
    inventory = {label['publicId']: label for label in board['labels']}
    owners = owned_label_ids(saved)
    if len(owners) != len(set(owners)):
        raise RuntimeError('Duplicate Kan label ownership in state')
    for identity, entry in mappings.items():
        if not entry.get('publicId'):
            # The create may have succeeded before a timeout or process failure.
            raise RuntimeError(
                f'Uncertain creation for GitHub label {identity}; '
                'inspect its pending state before retrying')
    active = {}
    for identity, fields in source.items():
        entry = mappings.get(identity)
        label = inventory.get(entry['publicId']) if entry else None
        if not label:
            # Persist intent before POST. An uncertain outcome must never create duplicates.
            retired = (entry.get('retiredPublicIds', []) + [entry['publicId']]
                       if entry else [])
            mappings[identity] = {'pending': fields, 'retiredPublicIds': retired}
            save()
            try:
                label = kan('/labels', {**fields, 'boardPublicId': board['publicId']})
            except HTTPError as error:
                if 400 <= error.code < 500 and error.code not in (408, 499):
                    if entry:
                        mappings[identity] = entry
                    else:
                        del mappings[identity]
                    save()
                error.close()
                raise
            if label['publicId'] in inventory or label['publicId'] in owners:
                raise RuntimeError('Kan returned an existing label identity')
            mappings[identity] = {
                'publicId': label['publicId'], 'retiredPublicIds': retired}
            inventory[label['publicId']] = label
            owners.append(label['publicId'])
            save()
        elif any(label[key] != value for key, value in fields.items()):
            kan('/labels/' + label['publicId'], fields)
        active[identity] = label['publicId']
    # Retain retired mappings to remove their assignments, without propagating deletes.
    managed = {entry['publicId'] for entry in mappings.values()
               if entry.get('publicId')}
    managed.update(identity for entry in mappings.values()
                   for identity in entry.get('retiredPublicIds', []))
    return active, managed


def issue_label_ids(issue, active):
    if not isinstance(issue.get('labels'), list):
        raise ValueError('Expected an issue label list')
    result = set()
    for label in issue['labels']:
        if (not isinstance(label, dict) or type(label.get('id')) is not int
                or str(label['id']) not in active):
            raise ValueError('Issue label missing from repository snapshot; retry next sync')
        result.add(active[str(label['id'])])
    return result


def sync_card_labels(kan, card, board_id, desired, managed):
    current = {label['publicId'] for label in card['labels']}
    changes = (desired - current) | ((current & managed) - desired)
    updated = False
    for identity in sorted(changes):
        # This API toggles rather than sets membership. Re-read before every toggle.
        fresh = kan('/cards/' + card['publicId'])
        if fresh['list']['board']['publicId'] != board_id:
            raise RuntimeError('Card moved outside its mapped board')
        present = identity in {label['publicId'] for label in fresh['labels']}
        if present == (identity in desired):
            continue
        result = kan('/cards/' + card['publicId'] + '/labels/' + identity, {})
        if result['newLabel'] != (identity in desired):
            raise RuntimeError('Concurrent card-label edit; retry next sync')
        updated = True
    return updated
